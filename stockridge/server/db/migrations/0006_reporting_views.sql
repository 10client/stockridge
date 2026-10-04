-- =====================================================================
-- STOCKRIDGE — migration 0006: reporting views
-- =====================================================================
-- EVERY date-bucketing view uses West Africa Time, never raw UTC.
--
-- The pharmacy system this was decoupled from shipped a whole migration to fix
-- exactly this bug, after it was live-verified: every day-based report bucketed
-- by UTC, so a sale made between 00:00 and 00:59 Lagos time was counted under
-- the PREVIOUS calendar day. A shop trading past midnight — and in Nigeria many
-- do — had a daily sales report that was wrong every single day, in a way that
-- looked plausible because the monthly total still came out right.
--
-- Nigeria observes WAT (UTC+1) year-round with no daylight saving, so this is a
-- fixed offset. It is written as '+1 hours' here and defined once in
-- shared/lib/timegeo.js (WAT_UTC_OFFSET_HOURS, SQL_WAT_DATE); if it ever
-- changed, the change is one constant plus one migration, not an audit.
--
-- Shift order matters: date(created_at, '+1 hours') is NOT the same as
-- date(created_at) + 1 day for a row stamped at 23:30 UTC.

-- ---------------------------------------------------------------------
-- SALES
-- ---------------------------------------------------------------------
CREATE VIEW v_daily_sales_by_branch AS
SELECT
    s.business_id,
    s.branch_id,
    b.name AS branch_name,
    b.code AS branch_code,
    date(s.created_at, '+1 hours')                AS sale_day,
    s.sale_type,
    COUNT(*)                                      AS sale_count,
    SUM(s.total_kobo)                             AS total_kobo,
    SUM(s.total_kobo) / 100.0                     AS total,
    SUM(s.discount_kobo) / 100.0                  AS discounts,
    SUM(s.vat_kobo) / 100.0                       AS vat,
    SUM(s.cost_kobo) / 100.0                      AS cogs,
    SUM(s.margin_kobo) / 100.0                    AS margin,
    -- A margin PERCENT computed over a zero-revenue day would divide by zero
    -- and SQLite would return NULL, which then breaks any SUM over the view.
    CASE WHEN SUM(s.total_kobo) > 0
         THEN ROUND(100.0 * SUM(s.margin_kobo) / SUM(s.total_kobo), 2)
         ELSE 0 END                               AS margin_percent,
    SUM(s.balance_kobo) / 100.0                   AS outstanding,
    SUM(CASE WHEN s.voided_at IS NOT NULL THEN 1 ELSE 0 END) AS void_count
FROM sales s
JOIN branches b ON b.id = s.branch_id
WHERE s.is_deleted = 0
  AND s.status NOT IN ('QUOTE','VOIDED')
GROUP BY s.business_id, s.branch_id, sale_day, s.sale_type;

CREATE VIEW v_daily_sales_total AS
SELECT
    business_id,
    sale_day,
    SUM(sale_count)      AS sale_count,
    SUM(total_kobo)      AS total_kobo,
    SUM(total)           AS total,
    SUM(discounts)       AS discounts,
    SUM(vat)             AS vat,
    SUM(cogs)            AS cogs,
    SUM(margin)          AS margin,
    CASE WHEN SUM(total_kobo) > 0
         THEN ROUND(100.0 * SUM(total_kobo - (cogs * 100)) / SUM(total_kobo), 2)
         ELSE 0 END      AS margin_percent,
    SUM(outstanding)     AS outstanding,
    SUM(void_count)      AS void_count
FROM v_daily_sales_by_branch
GROUP BY business_id, sale_day;

-- Hourly shape of the trading day. Tells a manager whether a second till or a
-- second cashier is worth paying for, which is a decision nobody can make from
-- a daily total.
CREATE VIEW v_hourly_sales_by_branch AS
SELECT
    s.branch_id,
    b.name AS branch_name,
    date(s.created_at, '+1 hours')                          AS sale_day,
    CAST(strftime('%H', s.created_at, '+1 hours') AS INTEGER) AS sale_hour,
    COUNT(*)                                                AS sale_count,
    SUM(s.total_kobo) / 100.0                               AS total,
    SUM(s.margin_kobo) / 100.0                              AS margin
FROM sales s
JOIN branches b ON b.id = s.branch_id
WHERE s.is_deleted = 0 AND s.status NOT IN ('QUOTE','VOIDED')
GROUP BY s.branch_id, sale_day, sale_hour;

-- Retail vs wholesale split. Two different businesses with different margins,
-- different payment patterns and different customer relationships; a combined
-- average of them describes neither.
CREATE VIEW v_sales_by_type AS
SELECT
    s.business_id,
    s.branch_id,
    s.sale_type,
    date(s.created_at, '+1 hours') AS sale_day,
    COUNT(*)                       AS sale_count,
    SUM(s.total_kobo) / 100.0      AS revenue,
    SUM(s.margin_kobo) / 100.0     AS margin,
    CASE WHEN SUM(s.total_kobo) > 0
         THEN ROUND(100.0 * SUM(s.margin_kobo) / SUM(s.total_kobo), 2) ELSE 0 END AS margin_percent,
    AVG(s.total_kobo) / 100.0      AS average_basket
FROM sales s
WHERE s.is_deleted = 0 AND s.status NOT IN ('QUOTE','VOIDED')
GROUP BY s.business_id, s.branch_id, s.sale_type, sale_day;

CREATE VIEW v_sales_by_category AS
SELECT
    s.business_id,
    s.branch_id,
    si.category_code,
    pc.name AS category_name,
    date(s.created_at, '+1 hours') AS sale_day,
    SUM(si.base_quantity)          AS units,
    SUM(si.line_net_kobo) / 100.0  AS revenue_net_of_vat,
    SUM(si.line_vat_kobo) / 100.0  AS vat,
    SUM(si.line_cost_kobo) / 100.0 AS cogs,
    SUM(si.line_margin_kobo)/100.0 AS margin,
    CASE WHEN SUM(si.line_net_kobo) > 0
         THEN ROUND(100.0 * SUM(si.line_margin_kobo) / SUM(si.line_net_kobo), 2) ELSE 0 END AS margin_percent
FROM sale_items si
JOIN sales s ON s.id = si.sale_id AND s.is_deleted = 0 AND s.status NOT IN ('QUOTE','VOIDED')
LEFT JOIN product_categories pc ON pc.id = si.category_id
WHERE si.is_deleted = 0
GROUP BY s.business_id, s.branch_id, si.category_code, sale_day;

CREATE VIEW v_top_products AS
SELECT
    s.business_id,
    si.product_id,
    si.product_name,
    si.brand_name,
    si.category_code,
    SUM(si.base_quantity)          AS units_sold,
    COUNT(DISTINCT si.sale_id)     AS times_sold,
    SUM(si.line_net_kobo) / 100.0  AS revenue,
    SUM(si.line_margin_kobo)/100.0 AS margin,
    CASE WHEN SUM(si.line_net_kobo) > 0
         THEN ROUND(100.0 * SUM(si.line_margin_kobo) / SUM(si.line_net_kobo), 2) ELSE 0 END AS margin_percent
FROM sale_items si
JOIN sales s ON s.id = si.sale_id AND s.is_deleted = 0 AND s.status NOT IN ('QUOTE','VOIDED')
WHERE si.is_deleted = 0
GROUP BY s.business_id, si.product_id
ORDER BY revenue DESC;

-- Dead stock: what has not moved. A retailer that cannot see this is holding
-- capital in a corner of the shop and paying rent on it.
CREATE VIEW v_slow_moving_stock AS
SELECT
    sb.branch_id,
    b.name AS branch_name,
    sb.product_id,
    p.name AS product_name,
    p.sku,
    pc.name AS category_name,
    SUM(sb.quantity_on_hand)                                   AS units_on_hand,
    SUM(sb.quantity_on_hand * sb.cost_per_unit)                AS cost_value,
    MAX(sm.moved_at)                                           AS last_movement_at,
    CAST(julianday('now') - julianday(MAX(COALESCE(sm.moved_at, sb.received_at))) AS INTEGER) AS days_since_movement,
    COUNT(DISTINCT sm.id)                                      AS movement_count
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches b ON b.id = sb.branch_id
LEFT JOIN product_categories pc ON pc.id = p.category_id
LEFT JOIN stock_movements sm ON sm.product_id = sb.product_id
     AND sm.branch_id = sb.branch_id AND sm.direction = -1
WHERE sb.is_deleted = 0 AND sb.quantity_on_hand > 0
GROUP BY sb.branch_id, sb.product_id
HAVING days_since_movement > 60 OR movement_count = 0;

-- ---------------------------------------------------------------------
-- STOCK
-- ---------------------------------------------------------------------
CREATE VIEW v_stock_by_branch_product AS
SELECT
    p.business_id,
    sb.branch_id,
    b.name AS branch_name,
    sb.product_id,
    p.name AS product_name,
    p.sku,
    p.base_unit,
    pc.name AS category_name,
    p.reorder_level,
    SUM(sb.quantity_on_hand)                          AS quantity_on_hand,
    SUM(sb.quantity_reserved)                         AS quantity_reserved,
    SUM(sb.quantity_on_hand - sb.quantity_reserved)   AS sellable,
    SUM(sb.quantity_damaged)                          AS quantity_damaged,
    SUM(sb.quantity_on_hand * sb.cost_per_unit)       AS cost_value,
    SUM(sb.quantity_on_hand * sb.selling_price_per_unit) AS retail_value,
    COUNT(sb.id)                                      AS batch_count,
    MIN(sb.best_before_date)                          AS earliest_best_before
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches b ON b.id = sb.branch_id
LEFT JOIN product_categories pc ON pc.id = p.category_id
WHERE sb.is_deleted = 0
GROUP BY sb.branch_id, sb.product_id;

CREATE VIEW v_stock_value_by_branch AS
SELECT
    sb.branch_id,
    b.business_id,
    b.name AS branch_name,
    SUM(sb.quantity_on_hand)                                   AS units,
    SUM(sb.quantity_on_hand * sb.cost_per_unit)                AS cost_value,
    SUM(sb.quantity_on_hand * sb.selling_price_per_unit)       AS retail_value,
    SUM(sb.quantity_on_hand * sb.selling_price_per_unit)
      - SUM(sb.quantity_on_hand * sb.cost_per_unit)            AS potential_margin,
    SUM(sb.quantity_reserved)                                  AS reserved_units,
    SUM(sb.quantity_damaged)                                   AS damaged_units
FROM stock_batches sb
JOIN branches b ON b.id = sb.branch_id
WHERE sb.is_deleted = 0
GROUP BY sb.branch_id;

-- LOW STOCK. Uses SELLABLE (on hand less reserved), not on hand: a branch
-- showing 3 on hand with 3 reserved has nothing to sell, and an alert that says
-- otherwise arrives after the customer has already been disappointed.
CREATE VIEW v_low_stock_alerts AS
SELECT
    p.business_id,
    v.branch_id,
    v.branch_name,
    p.id AS product_id,
    p.name AS product_name,
    p.sku,
    v.category_name,
    p.base_unit,
    v.quantity_on_hand,
    v.quantity_reserved,
    v.sellable,
    p.reorder_level,
    p.reorder_quantity,
    v.cost_value,
    CASE
        WHEN v.sellable <= 0 THEN 'OUT_OF_STOCK'
        WHEN v.sellable <= p.reorder_level THEN 'CRITICAL'
        WHEN v.sellable <= p.reorder_level * 2 THEN 'LOW'
        ELSE 'WATCH'
    END AS urgency,
    br.phone AS branch_phone
FROM v_stock_by_branch_product v
JOIN products p ON p.id = v.product_id
JOIN branches br ON br.id = v.branch_id
WHERE p.is_deleted = 0
  AND p.is_stocked = 1
  AND p.is_active = 1
  AND v.sellable <= MAX(p.reorder_level * 2, 1);

-- SHELF LIFE (generalised from v_expiry_alerts). Applies to food and drink in
-- the wholesale vertical, paint and adhesive in building materials, foam in
-- furniture. Same three horizons, different actions: food gets marked down or
-- destroyed, paint gets stirred and sold.
CREATE VIEW v_shelf_life_alerts AS
SELECT
    p.business_id,
    sb.branch_id,
    b.name AS branch_name,
    sb.id AS stock_batch_id,
    sb.product_id,
    p.name AS product_name,
    p.sku,
    pc.name AS category_name,
    sb.batch_no,
    sb.best_before_date,
    CAST(julianday(sb.best_before_date) - julianday('now', '+1 hours') AS INTEGER) AS days_remaining,
    sb.quantity_on_hand,
    sb.quantity_on_hand * sb.cost_per_unit         AS cost_value,
    sb.quantity_on_hand * sb.selling_price_per_unit AS retail_value,
    CASE
        WHEN sb.best_before_date < date('now', '+1 hours') THEN 'EXPIRED'
        WHEN julianday(sb.best_before_date) - julianday('now','+1 hours') <= 7  THEN 'WITHIN_7'
        WHEN julianday(sb.best_before_date) - julianday('now','+1 hours') <= 30 THEN 'WITHIN_30'
        ELSE 'WITHIN_90'
    END AS band,
    CASE
        WHEN sb.best_before_date < date('now', '+1 hours') THEN 'WRITE_OFF'
        WHEN julianday(sb.best_before_date) - julianday('now','+1 hours') <= 7 THEN 'MARKDOWN_OR_RETURN_TO_SUPPLIER'
        ELSE 'MARKDOWN'
    END AS recommended_action
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches b ON b.id = sb.branch_id
LEFT JOIN product_categories pc ON pc.id = p.category_id
WHERE sb.is_deleted = 0
  AND sb.best_before_date IS NOT NULL
  AND sb.quantity_on_hand > 0
  AND sb.status = 'ACTIVE'
  AND julianday(sb.best_before_date) - julianday('now','+1 hours') <= 90;

-- WARRANTY EXPIRING. Surfaced so a shop can contact a customer BEFORE cover
-- lapses — both a genuine service and, for an extended-cover seller, a sale.
CREATE VIEW v_warranty_expiring AS
SELECT
    sn.business_id,
    sn.branch_id,
    sn.id AS serial_id,
    sn.serial_number,
    sn.product_id,
    p.name AS product_name,
    sn.customer_id,
    c.name AS customer_name,
    c.phone AS customer_phone,
    sn.sold_at,
    sn.warranty_expires_on,
    CAST(julianday(sn.warranty_expires_on) - julianday('now','+1 hours') AS INTEGER) AS days_remaining,
    sn.warranty_status,
    sn.warranty_extended_months
FROM serial_numbers sn
JOIN products p ON p.id = sn.product_id
LEFT JOIN customers c ON c.id = sn.customer_id
WHERE sn.is_deleted = 0
  AND sn.status = 'SOLD'
  AND sn.warranty_expires_on IS NOT NULL
  AND sn.warranty_status = 'IN_WARRANTY'
  AND julianday(sn.warranty_expires_on) - julianday('now','+1 hours') BETWEEN 0 AND 60;

-- ---------------------------------------------------------------------
-- DEBTORS / CREDITORS
-- ---------------------------------------------------------------------
-- Balances are DERIVED from the ledger, never stored as a running total.
CREATE VIEW v_debtor_balances AS
SELECT
    c.business_id,
    c.id AS customer_id,
    c.name AS customer_name,
    c.company_name,
    c.phone,
    c.customer_class,
    c.account_status,
    c.credit_limit,
    c.terms_code,
    br.name AS home_branch_name,
    SUM(CASE WHEN dl.direction = 'DEBIT'  THEN dl.amount_kobo ELSE 0 END) / 100.0 AS total_debited,
    SUM(CASE WHEN dl.direction = 'CREDIT' THEN dl.amount_kobo ELSE 0 END) / 100.0 AS total_credited,
    (SUM(CASE WHEN dl.direction = 'DEBIT'  THEN dl.amount_kobo ELSE 0 END)
     - SUM(CASE WHEN dl.direction = 'CREDIT' THEN dl.amount_kobo ELSE 0 END)) / 100.0 AS balance,
    MAX(dl.entry_date) AS last_entry_date,
    COUNT(dl.id)       AS entry_count
FROM customers c
LEFT JOIN debtor_ledger dl ON dl.customer_id = c.id AND dl.is_deleted = 0
LEFT JOIN branches br ON br.id = c.home_branch_id
WHERE c.is_deleted = 0
GROUP BY c.id;

-- Ageing requires comparing each open entry's due date with today in WAT.
CREATE VIEW v_debtor_ageing AS
SELECT
    c.business_id,
    c.id AS customer_id,
    c.name AS customer_name,
    c.phone,
    c.customer_class,
    c.account_status,
    c.credit_limit,
    dl.id AS entry_id,
    dl.entry_type,
    dl.reference,
    dl.entry_date,
    dl.due_date,
    dl.amount_kobo / 100.0 AS amount,
    CAST(julianday(date('now','+1 hours')) - julianday(COALESCE(dl.due_date, dl.entry_date)) AS INTEGER) AS days_overdue,
    CASE
        WHEN dl.due_date IS NULL OR dl.due_date >= date('now','+1 hours') THEN 'CURRENT'
        WHEN julianday(date('now','+1 hours')) - julianday(dl.due_date) <= 30  THEN 'D1_30'
        WHEN julianday(date('now','+1 hours')) - julianday(dl.due_date) <= 60  THEN 'D31_60'
        WHEN julianday(date('now','+1 hours')) - julianday(dl.due_date) <= 90  THEN 'D61_90'
        WHEN julianday(date('now','+1 hours')) - julianday(dl.due_date) <= 180 THEN 'D91_180'
        ELSE 'D180_PLUS'
    END AS bucket
FROM debtor_ledger dl
JOIN customers c ON c.id = dl.customer_id AND c.is_deleted = 0
WHERE dl.is_deleted = 0
  AND dl.entry_type IN ('SALE','DEBIT_NOTE','INSTALLMENT_DUE','OPENING_BALANCE','FX_REVALUATION');

CREATE VIEW v_creditor_balances AS
SELECT
    s.business_id,
    s.id AS supplier_id,
    s.name AS supplier_name,
    s.phone,
    s.tin,
    s.default_terms_code,
    s.credit_limit,
    SUM(CASE WHEN cl.direction = 'DEBIT'  THEN cl.amount_kobo ELSE 0 END) / 100.0 AS total_debited,
    SUM(CASE WHEN cl.direction = 'CREDIT' THEN cl.amount_kobo ELSE 0 END) / 100.0 AS total_credited,
    (SUM(CASE WHEN cl.direction = 'DEBIT'  THEN cl.amount_kobo ELSE 0 END)
     - SUM(CASE WHEN cl.direction = 'CREDIT' THEN cl.amount_kobo ELSE 0 END)) / 100.0 AS balance
FROM suppliers s
LEFT JOIN creditor_ledger cl ON cl.supplier_id = s.id AND cl.is_deleted = 0
WHERE s.is_deleted = 0
GROUP BY s.id;

-- CHANGE OWED OUTSTANDING. A liability, and the reason a drawer can be short
-- while the books are right.
CREATE VIEW v_change_owed_outstanding AS
SELECT
    co.business_id,
    co.branch_id,
    b.name AS branch_name,
    co.id,
    co.claim_code,
    co.customer_id,
    co.customer_name,
    co.customer_phone,
    co.amount_kobo / 100.0 AS amount,
    co.reason,
    date(co.created_at, '+1 hours') AS owed_since,
    CAST(julianday('now','+1 hours') - julianday(date(co.created_at,'+1 hours')) AS INTEGER) AS days_outstanding,
    co.review_after_days,
    CASE WHEN CAST(julianday('now','+1 hours') - julianday(date(co.created_at,'+1 hours')) AS INTEGER)
              > co.review_after_days THEN 1 ELSE 0 END AS due_for_review
FROM change_owed co
JOIN branches b ON b.id = co.branch_id
WHERE co.status = 'OUTSTANDING' AND co.is_deleted = 0;

CREATE VIEW v_branch_safe_balances AS
SELECT
    bsl.branch_id,
    b.name AS branch_name,
    b.business_id,
    SUM(CASE WHEN bsl.direction = 'IN'  THEN bsl.amount_kobo ELSE -bsl.amount_kobo END) / 100.0 AS safe_balance,
    SUM(CASE WHEN bsl.direction = 'IN'  THEN bsl.amount_kobo ELSE 0 END) / 100.0 AS total_in,
    SUM(CASE WHEN bsl.direction = 'OUT' THEN bsl.amount_kobo ELSE 0 END) / 100.0 AS total_out,
    COUNT(*) AS movement_count,
    MAX(bsl.created_at) AS last_movement_at
FROM branch_safe_ledger bsl
JOIN branches b ON b.id = bsl.branch_id
WHERE bsl.is_deleted = 0
GROUP BY bsl.branch_id;

-- ---------------------------------------------------------------------
-- INSTALMENTS / LAYAWAY / DELIVERY / WARRANTY
-- ---------------------------------------------------------------------
CREATE VIEW v_instalment_plans_active AS
SELECT
    ip.business_id,
    ip.branch_id,
    b.name AS branch_name,
    ip.id AS plan_id,
    ip.plan_number,
    ip.customer_id,
    c.name AS customer_name,
    c.phone AS customer_phone,
    ip.model,
    ip.status,
    ip.frequency,
    ip.total_kobo / 100.0     AS total,
    ip.deposit_kobo / 100.0   AS deposit,
    ip.paid_kobo / 100.0      AS paid,
    ip.outstanding_kobo / 100.0 AS outstanding,
    ip.late_fees_kobo / 100.0 AS late_fees,
    ip.instalment_count,
    ip.missed_count,
    ip.missed_before_default,
    ip.start_date,
    ip.last_due_date,
    isch.next_due_date,
    isch.next_amount,
    isch.overdue_count,
    CAST(julianday(date('now','+1 hours')) - julianday(isch.next_due_date) AS INTEGER) AS days_overdue
FROM instalment_plans ip
JOIN branches b ON b.id = ip.branch_id
JOIN customers c ON c.id = ip.customer_id
LEFT JOIN (
    SELECT plan_id,
           MIN(due_date) AS next_due_date,
           (SELECT amount_kobo / 100.0 FROM instalment_schedule s2
             WHERE s2.plan_id = s1.plan_id AND s2.status IN ('SCHEDULED','MISSED','PART_PAID')
             ORDER BY s2.due_date LIMIT 1) AS next_amount,
           SUM(CASE WHEN status = 'MISSED' THEN 1 ELSE 0 END) AS overdue_count
    FROM instalment_schedule s1
    WHERE status IN ('SCHEDULED','MISSED','PART_PAID') AND is_deleted = 0
    GROUP BY plan_id
) isch ON isch.plan_id = ip.id
WHERE ip.is_deleted = 0 AND ip.status IN ('ACTIVE','DEFAULTED');

CREATE VIEW v_instalments_due_this_week AS
SELECT
    isch.plan_id,
    ip.plan_number,
    ip.business_id,
    ip.branch_id,
    b.name AS branch_name,
    ip.customer_id,
    c.name AS customer_name,
    c.phone AS customer_phone,
    isch.seq,
    isch.due_date,
    isch.amount_kobo / 100.0 AS amount,
    isch.status,
    CAST(julianday(isch.due_date) - julianday(date('now','+1 hours')) AS INTEGER) AS days_until_due
FROM instalment_schedule isch
JOIN instalment_plans ip ON ip.id = isch.plan_id AND ip.is_deleted = 0 AND ip.status = 'ACTIVE'
JOIN customers c ON c.id = ip.customer_id
JOIN branches b ON b.id = ip.branch_id
WHERE isch.is_deleted = 0
  AND isch.status IN ('SCHEDULED','MISSED','PART_PAID')
  AND julianday(isch.due_date) - julianday(date('now','+1 hours')) BETWEEN -30 AND 7;

CREATE VIEW v_layaway_holds_active AS
SELECT
    lh.business_id,
    lh.branch_id,
    b.name AS branch_name,
    lh.id AS hold_id,
    lh.hold_number,
    lh.customer_id,
    COALESCE(c.name, lh.customer_name) AS customer_name,
    COALESCE(c.phone, lh.customer_phone) AS customer_phone,
    lh.status,
    lh.reason,
    lh.deposit / 100.0 * 100.0 AS deposit_placeholder,   -- replaced below; keeps column order stable
    lh.deposit_kobo / 100.0 AS deposit,
    lh.total_value_kobo / 100.0 AS total_value,
    lh.balance_kobo / 100.0 AS balance,
    lh.deposit_percent,
    lh.held_from,
    lh.expires_on,
    lh.extension_count,
    CAST(julianday(lh.expires_on) - julianday(date('now','+1 hours')) AS INTEGER) AS days_until_expiry,
    (SELECT SUM(quantity) FROM layaway_hold_items i WHERE i.hold_id = lh.id AND i.is_deleted = 0) AS units_held
FROM layaway_holds lh
JOIN branches b ON b.id = lh.branch_id
LEFT JOIN customers c ON c.id = lh.customer_id
WHERE lh.is_deleted = 0 AND lh.status = 'ACTIVE';

CREATE VIEW v_delivery_jobs_open AS
SELECT
    dj.business_id,
    dj.branch_id,
    b.name AS branch_name,
    dj.id AS job_id,
    dj.job_number,
    dj.job_type,
    dj.status,
    dj.priority,
    dj.scheduled_date,
    dj.window_start,
    dj.window_end,
    dj.customer_id,
    c.name AS customer_name,
    c.phone AS customer_phone,
    dj.contact_phone,
    dj.address,
    dj.area,
    dj.zone_code,
    dj.distance_km,
    dj.driver_id,
    COALESCE(u.full_name, dj.driver_name) AS driver_name,
    dj.vehicle_type,
    dj.vehicle_registration,
    dj.fee_kobo / 100.0 AS fee,
    dj.fee_collected,
    dj.cod_amount_kobo / 100.0 AS cod_amount,
    dj.attempt_count,
    dj.needs_two_man,
    (SELECT SUM(quantity) FROM delivery_job_items i WHERE i.job_id = dj.id AND i.is_deleted = 0) AS item_count,
    CASE WHEN dj.scheduled_date < date('now','+1 hours')
              AND dj.status IN ('SCHEDULED','CONFIRMED') THEN 1 ELSE 0 END AS is_overdue
FROM delivery_jobs dj
JOIN branches b ON b.id = dj.branch_id
LEFT JOIN customers c ON c.id = dj.customer_id
LEFT JOIN users u ON u.id = dj.driver_id
WHERE dj.is_deleted = 0
  AND dj.status IN ('SCHEDULED','CONFIRMED','DISPATCHED','IN_TRANSIT','FAILED','RESCHEDULED');

CREATE VIEW v_warranty_claims_open AS
SELECT
    wc.business_id,
    wc.branch_id,
    b.name AS branch_name,
    wc.id AS claim_id,
    wc.claim_number,
    wc.serial_number,
    wc.product_id,
    p.name AS product_name,
    wc.customer_name,
    wc.customer_phone,
    wc.claim_type,
    wc.status,
    wc.responsibility,
    wc.chargeable,
    wc.in_cover_at_open,
    wc.cover_expires_on,
    wc.rma_number,
    wc.opened_on,
    wc.expected_return_date,
    wc.quoted_amount_kobo / 100.0 AS quoted_amount,
    wc.repair_cost_kobo / 100.0   AS repair_cost,
    CAST(julianday(date('now','+1 hours')) - julianday(wc.opened_on) AS INTEGER) AS days_open,
    CASE WHEN wc.expected_return_date IS NOT NULL
              AND wc.expected_return_date < date('now','+1 hours') THEN 1 ELSE 0 END AS promise_broken
FROM warranty_claims wc
JOIN branches b ON b.id = wc.branch_id
JOIN products p ON p.id = wc.product_id
WHERE wc.is_deleted = 0 AND wc.status NOT IN ('COMPLETED','CANCELLED','REJECTED');

-- ---------------------------------------------------------------------
-- COMPLIANCE EXPIRY  (one query over the generic table, replacing two
-- hard-coded licence columns)
-- ---------------------------------------------------------------------
CREATE VIEW v_compliance_expiry_alerts AS
SELECT
    cc.business_id,
    bs.name AS business_name,
    cc.branch_id,
    b.name AS branch_name,
    cc.id AS certificate_id,
    cc.certificate_type,
    cc.certificate_number,
    cc.issuing_authority,
    cc.holder_name,
    cc.expiry_date,
    cc.alert_days_before,
    CAST(julianday(cc.expiry_date) - julianday(date('now','+1 hours')) AS INTEGER) AS days_until_expiry,
    cc.renewal_cost,
    cc.renewal_agent,
    CASE
        WHEN cc.expiry_date < date('now','+1 hours') THEN 'EXPIRED'
        WHEN julianday(cc.expiry_date) - julianday(date('now','+1 hours')) <= cc.alert_days_before THEN 'EXPIRING_SOON'
        ELSE 'VALID'
    END AS alert_level,
    p.name AS product_name,
    cc.last_reminded_at,
    cc.reminder_count
FROM compliance_certificates cc
JOIN businesses bs ON bs.id = cc.business_id
LEFT JOIN branches b ON b.id = cc.branch_id
LEFT JOIN products p ON p.id = cc.product_id
WHERE cc.is_deleted = 0
  AND cc.expiry_date IS NOT NULL
  AND cc.status NOT IN ('NOT_APPLICABLE','REVOKED')
  AND julianday(cc.expiry_date) - julianday(date('now','+1 hours')) <= cc.alert_days_before;

-- ---------------------------------------------------------------------
-- TILLS / ATTENDANCE / FRAUD SIGNALS
-- ---------------------------------------------------------------------
CREATE VIEW v_till_variance AS
SELECT
    ts.branch_id,
    b.name AS branch_name,
    b.business_id,
    ts.id AS till_session_id,
    ts.till_no,
    ts.status,
    u.full_name AS opened_by_name,
    ts.opened_at,
    ts.closed_at,
    ts.closed_date,
    ts.opening_float_kobo / 100.0 AS opening_float,
    ts.expected_cash_kobo / 100.0 AS expected_cash,
    ts.counted_cash_kobo / 100.0  AS counted_cash,
    ts.variance_kobo / 100.0      AS variance,
    ts.variance_tolerance_kobo / 100.0 AS tolerance,
    ts.sales_count,
    ts.void_count,
    ts.refund_count,
    ts.requires_review,
    ts.reviewed_by,
    ru.full_name AS reviewed_by_name,
    CASE
        WHEN ts.variance_kobo IS NULL THEN 'NOT_COUNTED'
        WHEN ts.variance_kobo = 0 THEN 'BALANCED'
        WHEN ABS(ts.variance_kobo) <= ts.variance_tolerance_kobo THEN 'WITHIN_TOLERANCE'
        WHEN ts.variance_kobo < 0 THEN 'SHORT'
        ELSE 'OVER'
    END AS variance_status
FROM till_sessions ts
JOIN branches b ON b.id = ts.branch_id
JOIN users u ON u.id = ts.opened_by
LEFT JOIN users ru ON ru.id = ts.reviewed_by
WHERE ts.is_deleted = 0 AND ts.status != 'OPEN';

-- VOID RATE BY USER. A lightweight shrinkage/fraud signal: a cashier whose void
-- rate is far above their peers is either mis-keying constantly (a training
-- issue) or selling for cash and voiding (a theft issue). Both need a
-- conversation, and neither is visible from a sales total.
CREATE VIEW v_void_audit_by_user AS
SELECT
    s.business_id,
    s.branch_id,
    b.name AS branch_name,
    s.sold_by AS user_id,
    u.full_name,
    u.role,
    u.job_title,
    COUNT(*)                                             AS total_sales,
    SUM(CASE WHEN s.voided_at IS NOT NULL THEN 1 ELSE 0 END) AS voided_sales,
    SUM(CASE WHEN s.voided_at IS NOT NULL THEN s.total_kobo ELSE 0 END) / 100.0 AS voided_value,
    CASE WHEN COUNT(*) > 0
         THEN ROUND(100.0 * SUM(CASE WHEN s.voided_at IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 2)
         ELSE 0 END                                      AS void_rate_percent,
    SUM(CASE WHEN s.discount_kobo > 0 THEN 1 ELSE 0 END) AS discounted_sales,
    SUM(s.discount_kobo) / 100.0                         AS discount_value,
    MIN(date(s.created_at,'+1 hours'))                   AS first_sale_day,
    MAX(date(s.created_at,'+1 hours'))                   AS last_sale_day
FROM sales s
JOIN users u ON u.id = s.sold_by
JOIN branches b ON b.id = s.branch_id
WHERE s.is_deleted = 0
GROUP BY s.business_id, s.branch_id, s.sold_by
HAVING total_sales >= 5;

-- Sales outside trading hours. Not proof of anything, but a 03:40 sale is worth
-- a second look, and a pattern of them is worth a conversation.
CREATE VIEW v_off_hours_sales AS
SELECT
    s.business_id,
    s.branch_id,
    b.name AS branch_name,
    b.opening_time,
    b.closing_time,
    s.id AS sale_id,
    s.sale_number,
    s.total_kobo / 100.0 AS total,
    s.sold_by,
    u.full_name AS sold_by_name,
    date(s.created_at,'+1 hours') AS sale_day,
    strftime('%H:%M', s.created_at, '+1 hours') AS sale_time_wat,
    CAST(strftime('%H', s.created_at, '+1 hours') AS INTEGER) AS sale_hour
FROM sales s
JOIN branches b ON b.id = s.branch_id
JOIN users u ON u.id = s.sold_by
WHERE s.is_deleted = 0
  AND s.status NOT IN ('QUOTE','VOIDED')
  AND (
        (b.opening_time IS NOT NULL AND strftime('%H:%M', s.created_at,'+1 hours') < b.opening_time)
     OR (b.closing_time IS NOT NULL AND strftime('%H:%M', s.created_at,'+1 hours') >= b.closing_time)
  );

CREATE VIEW v_attendance_summary AS
SELECT
    sa.business_id,
    sa.branch_id,
    b.name AS branch_name,
    sa.user_id,
    u.full_name,
    u.role,
    sa.attendance_date,
    sa.clock_in_at,
    sa.clock_out_at,
    sa.classification,
    sa.distance_meters,
    sa.geofence_radius,
    sa.method,
    sa.flagged,
    sa.flag_reason,
    sa.reviewed_by,
    sa.reviewed_at,
    sa.review_outcome,
    sa.worked_minutes,
    sa.is_overtime,
    ROUND(sa.worked_minutes / 60.0, 2) AS worked_hours
    -- reviewed_by / reviewed_at are selected here because
    -- v_attendance_flagged_unreviewed filters on reviewed_at. A view that omits
    -- a column its dependents need is invalid at CREATE time, and SQLite only
    -- reports it when something forces a re-validation — which is how this one
    -- survived until an unrelated migration dropped a table.
FROM staff_attendance sa
JOIN branches b ON b.id = sa.branch_id
JOIN users u ON u.id = sa.user_id
WHERE sa.is_deleted = 0;

CREATE VIEW v_attendance_flagged_unreviewed AS
SELECT * FROM v_attendance_summary
WHERE flagged = 1 AND reviewed_at IS NULL;

-- ---------------------------------------------------------------------
-- SYNC / GL / SUBSCRIPTION
-- ---------------------------------------------------------------------
CREATE VIEW v_branch_sync_overview AS
SELECT
    b.business_id,
    b.id AS branch_id,
    b.name AS branch_name,
    b.is_active,
    bs.device_id,
    bs.device_label,
    bs.app_version,
    bs.last_heartbeat_at,
    bs.last_push_at,
    bs.last_pull_at,
    bs.pending_push_count,
    bs.consecutive_failures,
    bs.last_sync_error,
    CAST((julianday('now') - julianday(COALESCE(bs.last_heartbeat_at, '1970-01-01'))) * 1440 AS INTEGER) AS minutes_since_heartbeat,
    CASE
        WHEN bs.last_heartbeat_at IS NULL THEN 'NEVER_SYNCED'
        WHEN (julianday('now') - julianday(bs.last_heartbeat_at)) * 1440 > 1440 THEN 'STALE_OVER_A_DAY'
        WHEN (julianday('now') - julianday(bs.last_heartbeat_at)) * 1440 > 120  THEN 'STALE'
        WHEN bs.pending_push_count > 0 THEN 'PENDING_CHANGES'
        WHEN bs.consecutive_failures > 0 THEN 'FAILING'
        ELSE 'HEALTHY'
    END AS sync_health,
    (SELECT COUNT(*) FROM sync_conflicts sc WHERE sc.branch_id = b.id AND sc.reviewed_by IS NULL) AS unreviewed_conflicts
FROM branches b
LEFT JOIN branch_sync_status bs ON bs.branch_id = b.id
WHERE b.is_deleted = 0;

CREATE VIEW v_gl_account_balances AS
SELECT
    je.business_id,
    gl.account_id,
    gl.account_code,
    gl.account_name,
    ga.account_type,
    ga.normal_balance,
    gl.branch_id,
    gl.category_code,
    je.period,
    SUM(CASE WHEN gl.direction = 'DEBIT'  THEN gl.amount_kobo ELSE 0 END) / 100.0 AS total_debit,
    SUM(CASE WHEN gl.direction = 'CREDIT' THEN gl.amount_kobo ELSE 0 END) / 100.0 AS total_credit,
    -- The BALANCE respects the account's normal side: an asset's balance is
    -- debit-less-credit; a revenue account's is credit-less-debit. Reporting
    -- revenue as a negative number is a classic ledger-report bug.
    CASE WHEN ga.normal_balance = 'DEBIT'
         THEN (SUM(CASE WHEN gl.direction='DEBIT' THEN gl.amount_kobo ELSE -gl.amount_kobo END)) / 100.0
         ELSE (SUM(CASE WHEN gl.direction='CREDIT' THEN gl.amount_kobo ELSE -gl.amount_kobo END)) / 100.0
    END AS balance
FROM gl_journal_lines gl
JOIN gl_journal_entries je ON je.id = gl.journal_entry_id
    AND je.is_deleted = 0 AND je.status = 'POSTED'
JOIN gl_accounts ga ON ga.id = gl.account_id AND ga.is_deleted = 0
WHERE gl.is_deleted = 0
GROUP BY je.business_id, gl.account_id, gl.branch_id, gl.category_code, je.period;

CREATE VIEW v_gl_trial_balance AS
SELECT
    business_id,
    period,
    account_code,
    account_name,
    account_type,
    normal_balance,
    SUM(total_debit)  AS total_debit,
    SUM(total_credit) AS total_credit,
    SUM(balance)      AS balance
FROM v_gl_account_balances
GROUP BY business_id, period, account_code;

-- Subscription usage: what the client is using against what they pay for.
-- Counts ACTIVE rows only — a deactivated staff member frees their seat
-- immediately, and a closed branch frees its slot. Counting inactive rows would
-- bill a client for a shop they shut and a cashier who left, which is exactly
-- the contradiction that a half-implemented version of this had: deactivating a
-- staff member freed the seat but closing a branch freed nothing.
CREATE VIEW v_plan_usage AS
SELECT
    (SELECT COUNT(*) FROM businesses WHERE is_active = 1 AND is_deleted = 0) AS businesses_used,
    (SELECT COUNT(*) FROM branches   WHERE is_active = 1 AND is_deleted = 0) AS branches_used,
    (SELECT COUNT(*) FROM users WHERE role != 'ADMIN' AND is_active = 1 AND is_deleted = 0) AS staff_used,
    (SELECT max_businesses FROM client_settings WHERE id = 1) AS businesses_allowed,
    (SELECT max_branches   FROM client_settings WHERE id = 1) AS branches_allowed,
    (SELECT max_staff      FROM client_settings WHERE id = 1) AS staff_allowed,
    (SELECT subscription_status FROM client_settings WHERE id = 1) AS subscription_status,
    (SELECT subscription_plan   FROM client_settings WHERE id = 1) AS subscription_plan,
    (SELECT subscription_renewal_date FROM client_settings WHERE id = 1) AS renewal_date;
