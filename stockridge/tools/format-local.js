'use strict';

const path = require('node:path');
const { openDatabase } = require('../server/db/adapter');
const { migrate } = require('./migrate');
const { hashPin } = require('../server/lib/auth');
const WHT = require('../shared/lib/wht');

async function main() {
  const dbPath = path.join(__dirname, '..', 'data', 'stockridge.sqlite');
  const db = await openDatabase({ driver: 'sql.js', file: dbPath });

  console.log('[local-clean] running migrations...');
  await migrate(db);

  console.log('[local-clean] querying tables...');
  await db.prepare('PRAGMA foreign_keys = OFF;').run();
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != '_migrations';").all();

  for (const t of tables) {
    try {
      await db.prepare(`DELETE FROM ${t.name};`).run();
    } catch (e) {
      console.warn(`[local-clean] could not clear ${t.name}:`, e.message);
    }
  }
  await db.prepare('PRAGMA foreign_keys = ON;').run();

  // 1. Settings
  await db.prepare(`
    INSERT INTO client_settings (
      id, product_name, max_businesses, max_branches, max_staff,
      subscription_status, subscription_plan, multi_business_enabled,
      multi_branch_enabled, instalments_module_enabled,
      warranty_module_enabled, delivery_module_enabled,
      updated_at
    ) VALUES (
      1, 'StockRidge', 50, 100, 500,
      'ACTIVE', 'Enterprise', 1, 1, 1, 1, 1,
      datetime('now')
    );
  `).run();

  // 2. Admin User
  const adminPinHash = hashPin('9999');
  await db.prepare(`
    INSERT INTO users (
      id, branch_id, business_id, full_name, username, pin_hash,
      role, job_title, phone, email, is_driver, is_active, created_at, updated_at
    ) VALUES (
      'usr_admin_platform', NULL, NULL, 'Platform Administrator', 'admin', ?,
      'ADMIN', 'Vendor seat', '08000000000', 'admin@stockridge.ng', 0, 1, datetime('now'), datetime('now')
    );
  `).bind(adminPinHash).run();

  // 3. Statutory WHT rates
  for (let i = 0; i < WHT.SEED_RATES.length; i++) {
    const r = WHT.SEED_RATES[i];
    await db.prepare(`
      INSERT INTO wht_rates (
        id, code, description, rate_percent_small, rate_percent_medium, rate_percent_large,
        rate_percent, direction, statutory_reference, is_active, sort_order, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now')
      );
    `).bind(
      `wht_${r.code.toLowerCase()}`,
      r.code,
      r.description || r.label || r.code,
      r.rate_percent_small != null ? r.rate_percent_small : (r.small || 0),
      r.rate_percent_medium != null ? r.rate_percent_medium : (r.medium || 0),
      r.rate_percent_large != null ? r.rate_percent_large : (r.large || 0),
      r.rate_percent != null ? r.rate_percent : (r.small || 0),
      r.direction || 'BOTH',
      r.statutory_reference || 'WHT Regulations 2024',
      i + 1
    ).run();
  }

  // 4. Statutory Holidays
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
  for (const y of [year, year + 1]) {
    for (const [mmdd, name, type] of defs) {
      const date = `${y}-${mmdd}`;
      const state = type === 'STATE' ? 'LA' : null;
      await db.prepare(`
        INSERT INTO public_holidays (
          id, holiday_date, name, state_code, holiday_type, banks_closed, trading_affected, year, notes, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 1, ?, ?, 'Statutory holiday', datetime('now'), datetime('now')
        );
      `).bind(
        `hol_${y}_${mmdd.replace('-', '_')}`,
        date,
        name,
        state,
        type,
        type === 'RELIGIOUS' ? 1 : 0,
        y
      ).run();
    }
  }

  db.flush();
  console.log('[local-clean] done: admin created (username: admin, pin: 9999).');
}

main().catch((err) => {
  console.error('[local-clean] failed:', err);
  process.exit(1);
});
