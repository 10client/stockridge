'use strict';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.CLOUDFLARE_DATABASE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

async function executeSql(sql) {
  const res = await fetch(D1_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors || data)}`);
  }
  return data;
}

const ALL_TABLES = [
  'audit_log',
  'hash_chain_verifications',
  'hash_chain_heads',
  'hash_chained_registers',
  'gl_journal_lines',
  'gl_journal_entries',
  'gl_periods',
  'stock_movements',
  'serial_history',
  'creditor_ledger',
  'debtor_ledger',
  'debt_chase_log',
  'sale_payments',
  'sale_items',
  'sales_return_items',
  'sales_returns',
  'sales',
  'sale_authority_documents',
  'serial_numbers',
  'warranty_claim_events',
  'warranty_claims',
  'layaway_hold_items',
  'layaway_holds',
  'instalment_settlements',
  'instalment_schedule',
  'instalment_plans',
  'voucher_redemptions',
  'vouchers',
  'delivery_attempts',
  'delivery_job_items',
  'delivery_jobs',
  'compliance_certificates',
  'stock_batches',
  'stock_adjustments',
  'stocktake_lines',
  'stocktake_sessions',
  'stock_transfer_items',
  'stock_transfers',
  'purchase_order_receipts',
  'purchase_order_items',
  'purchase_orders',
  'branch_safe_ledger',
  'change_owed',
  'expenses',
  'till_sessions',
  'staff_attendance',
  'product_price_overrides',
  'customer_price_tiers',
  'volume_breaks',
  'promotions',
  'product_barcodes',
  'products',
  'gl_accounts',
  'fx_rates',
  'wht_entries',
  'delivery_zones',
  'suppliers',
  'customers',
  'brands',
  'product_categories',
  'document_counters',
  'pending_user_transfers',
  'user_assignment_history',
  'user_sessions',
  'login_attempts',
  'branch_sync_status',
  'sync_change_log',
  'sync_conflicts',
  'idempotency_keys',
  'scheduler_runs',
  'users',
  'branch_devices',
  'branches',
  'businesses',
  'wht_rates',
  'public_holidays',
  'client_settings',
];

async function main() {
  console.log('[format-clean] starting full database wipe and clean setup...');

  // 1. Truncate all tables
  const deleteStatements = [
    'PRAGMA foreign_keys = OFF;',
    ...ALL_TABLES.map((t) => `DELETE FROM ${t};`),
    'PRAGMA foreign_keys = ON;',
  ].join('\n');

  console.log('[format-clean] executing table truncate batch...');
  await executeSql(deleteStatements);
  console.log('[format-clean] all tables truncated successfully.');

  // 2. Set default client_settings
  const settingsSql = `
    INSERT INTO client_settings (
      id, product_name, default_vat_enabled, default_vat_rate_percent,
      wht_company_size, wht_enabled, pos_fee_percent, pos_fee_cap,
      pos_fee_configured, pos_settlement_business_days, max_businesses,
      max_branches, max_staff, subscription_status, subscription_plan,
      attendance_module_enabled, multi_business_enabled, multi_branch_enabled,
      instalments_module_enabled, warranty_module_enabled, delivery_module_enabled,
      accounting_module_enabled, offline_sync_enabled, managers_can_void_sales,
      managers_can_approve_expenses, managers_can_edit_prices,
      managers_can_override_price_floor, managers_can_dispatch_unpaid,
      managers_can_write_off_debt, staff_can_void_sales, staff_void_window_minutes,
      staff_can_adjust_stock, staff_adjustment_max_units, staff_max_discount_percent,
      price_floor_percent_of_cost, max_discount_percent, staff_can_spend_from_safe,
      staff_safe_spend_max, credit_enabled, credit_max_overdue_days,
      credit_max_concentration_pct, credit_requires_manager, updated_at
    ) VALUES (
      1, 'StockRidge', 0, 7.5,
      'SMALL', 1, 1.5, 2000,
      1, 1, 3,
      5, 25, 'ACTIVE', 'Enterprise',
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
      1, 1,
      1, 0,
      0, 1, 15,
      1, 5, 5,
      100, 25, 1,
      20000, 1, 30,
      25, 0, datetime('now')
    );
  `;
  await executeSql(settingsSql);
  console.log('[format-clean] default client_settings inserted.');

  // 3. Create the SINGLE Platform Administrator Account
  const { hashPin } = require('../server/lib/auth');
  const adminPinHash = hashPin('9999');

  const adminSql = `
    INSERT INTO users (
      id, branch_id, business_id, full_name, username, pin_hash,
      role, job_title, phone, email, is_driver, is_active, created_at, updated_at
    ) VALUES (
      'usr_admin_platform', NULL, NULL, 'Platform Administrator', 'admin', '${adminPinHash}',
      'ADMIN', 'Vendor seat', '08000000000', 'admin@stockridge.ng', 0, 1, datetime('now'), datetime('now')
    );
  `;
  await executeSql(adminSql);
  console.log('[format-clean] single admin account created (username: admin, pin: 9999).');

  // 4. Statutory reference data: WHT rates
  const WHT = require('../shared/lib/wht');
  const whtStmts = WHT.SEED_RATES.map((r, i) => `
    INSERT INTO wht_rates (
      id, code, description, rate_percent_small, rate_percent_medium, rate_percent_large,
      rate_percent, direction, statutory_reference, is_active, sort_order, created_at, updated_at
    ) VALUES (
      'wht_${r.code.toLowerCase()}', '${r.code}', '${(r.description || r.label || r.code).replace(/'/g, "''")}',
      ${r.rate_percent_small || r.small || 0}, ${r.rate_percent_medium || r.medium || 0}, ${r.rate_percent_large || r.large || 0},
      ${r.rate_percent || r.default || 0}, '${r.direction || 'BOTH'}', '${(r.statutory_reference || 'WHT Regulations 2024').replace(/'/g, "''")}',
      1, ${i + 1}, datetime('now'), datetime('now')
    );
  `);
  await executeSql(whtStmts.join('\n'));
  console.log('[format-clean] statutory WHT rates inserted.');

  // 5. Statutory reference data: Public holidays
  const year = new Date().getFullYear();
  const defs = [
    ['01-01', "New Year's Day", 'FEDERAL'],
    ['05-01', "Workers' Day", 'FEDERAL'],
    ['06-12', 'Democracy Day', 'FEDERAL'],
    ['10-01', "Independence Day", 'FEDERAL'],
    ['12-25', 'Christmas Day', 'FEDERAL'],
    ['12-26', 'Boxing Day', 'FEDERAL'],
    ['03-31', 'Eid el-Fitr', 'RELIGIOUS'],
    ['06-07', 'Eid el-Kabir', 'RELIGIOUS'],
    ['06-16', 'Eid el-Mawlid', 'RELIGIOUS'],
    ['05-29', 'Lagos State founding day', 'STATE'],
  ];
  const holStmts = [];
  for (const y of [year, year + 1]) {
    for (const [mmdd, name, type] of defs) {
      const date = `${y}-${mmdd}`;
      const state = type === 'STATE' ? 'LA' : null;
      holStmts.push(`
        INSERT INTO public_holidays (
          id, holiday_date, name, state_code, holiday_type, banks_closed, trading_affected, year, notes, created_at, updated_at
        ) VALUES (
          'hol_${y}_${mmdd.replace('-', '_')}', '${date}', '${name.replace(/'/g, "''")}', ${state ? `'${state}'` : 'NULL'},
          '${type}', 1, ${type === 'RELIGIOUS' ? 1 : 0}, ${y}, 'Statutory holiday', datetime('now'), datetime('now')
        );
      `);
    }
  }
  await executeSql(holStmts.join('\n'));
  console.log('[format-clean] statutory public holidays inserted.');

  // 6. Verification
  console.log('\n================ VERIFICATION ================');
  const userCheck = await executeSql('SELECT id, username, role, full_name, is_active FROM users;');
  console.log('Users in database:');
  console.table(userCheck.result[0].results);

  const tablesToCheck = [
    'users', 'businesses', 'branches', 'products', 'customers',
    'suppliers', 'sales', 'stock_batches', 'stock_movements',
    'gl_journal_entries', 'hash_chained_registers', 'expenses', 'till_sessions'
  ];

  const counts = [];
  for (const t of tablesToCheck) {
    const res = await executeSql(`SELECT COUNT(*) as count FROM ${t};`);
    counts.push({ Table: t, 'Row Count': res.result[0].results[0].count });
  }
  console.table(counts);
  console.log('==============================================');
  console.log('🎉 Clean formatting complete! Database contains ZERO seed records and ONLY the admin account.');
}

main().catch((err) => {
  console.error('[format-clean] FATAL:', err);
  process.exit(1);
});
