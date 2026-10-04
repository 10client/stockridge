'use strict';

const fs = require('fs');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '8c838389b678f2906c9a625bd35bdeb4';
const DATABASE_ID = process.env.CLOUDFLARE_DATABASE_ID || 'dec228ef-a050-4998-8b78-6a4796c2773e';
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

const TABLE_ORDER = [
  'client_settings',
  'public_holidays',
  'wht_rates',
  'businesses',
  'branches',
  'users',
  'document_counters',
  'product_categories',
  'brands',
  'customers',
  'suppliers',
  'delivery_zones',
  'fx_rates',
  'gl_accounts',
  'products',
  'product_barcodes',
  'compliance_certificates',
  'till_sessions',
  'branch_safe_ledger',
  'stock_batches',
  'layaway_holds',
  'layaway_hold_items',
  'sales',
  'sale_items',
  'sale_payments',
  'serial_numbers',
  'debtor_ledger',
  'creditor_ledger',
  'serial_history',
  'stock_movements',
  'gl_journal_entries',
  'gl_journal_lines',
  'hash_chained_registers',
  'hash_chain_heads',
  'audit_log',
];

(async () => {
  console.log('[seed-d1] reading server/db/seed.sql...');
  const lines = fs.readFileSync('server/db/seed.sql', 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.startsWith('INSERT INTO'))
    .map((l) => l.replace(/^INSERT INTO/, 'INSERT OR REPLACE INTO'));

  const byTable = {};
  for (const l of lines) {
    const m = l.match(/INSERT OR REPLACE INTO (\w+)/);
    if (m) {
      const tbl = m[1];
      if (!byTable[tbl]) byTable[tbl] = [];
      byTable[tbl].push(l);
    }
  }

  for (const tbl of TABLE_ORDER) {
    const stmts = byTable[tbl] || [];
    if (!stmts.length) continue;
    console.log(`[seed-d1] inserting ${stmts.length} rows into table '${tbl}'...`);
    const BATCH_SIZE = 25;
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
      const chunk = stmts.slice(i, i + BATCH_SIZE);
      await executeSql(chunk.join('\n'));
    }
  }

  console.log('\n[seed-d1] verifying seeded counts on Cloudflare D1:');
  const countRes = await executeSql(`
    SELECT 'businesses' as t, COUNT(*) as c FROM businesses
    UNION ALL SELECT 'branches', COUNT(*) FROM branches
    UNION ALL SELECT 'users', COUNT(*) FROM users
    UNION ALL SELECT 'products', COUNT(*) FROM products
    UNION ALL SELECT 'sales', COUNT(*) FROM sales
    UNION ALL SELECT 'gl_journal_entries', COUNT(*) FROM gl_journal_entries
  `);
  console.table(countRes.result[0].results);
  console.log('[seed-d1] Remote Cloudflare D1 successfully seeded!');
})().catch((err) => {
  console.error('[seed-d1] FATAL error:', err);
  process.exit(1);
});
