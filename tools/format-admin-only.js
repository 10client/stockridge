'use strict';
// Remove every business, user and trading row from one deployment, and leave
// the administrator. The PIN is not touched. This does not deploy a Worker.
//
//   node tools/format-admin-only.js --env=sample --yes
//   node tools/format-admin-only.js --env=production --yes

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const ENV_NAME = valueOf('--env');
const YES = args.includes('--yes');
const ROOT = path.resolve(__dirname, '..');
const WRANGLER_CONFIG = path.join('worker', 'wrangler.toml');

function loadEnvFile() {
  const file = path.join(ROOT, '.env.deploy');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]]) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value) process.env[m[1]] = value;
  }
}
loadEnvFile();

if (!YES) {
  console.error('Refusing to format a database without --yes.');
  process.exit(1);
}
if (!ENV_NAME || !['sample', 'production'].includes(ENV_NAME)) {
  console.error('Pass --env=sample or --env=production. There is no default.');
  process.exit(1);
}

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is not set.');
  process.exit(1);
}

function databaseName() {
  const text = fs.readFileSync(path.join(ROOT, WRANGLER_CONFIG), 'utf8');
  const header = ENV_NAME === 'production' ? '[[d1_databases]]' : `[[env.${ENV_NAME}.d1_databases]]`;
  const section = text.split(/(?=^\[)/m).find((part) => String(part.split('\n')[0] || '').trim() === header);
  if (!section) throw new Error(`${header} is missing`);
  const name = (section.match(/database_name\s*=\s*"([^"]*)"/) || [])[1];
  if (!name) throw new Error(`${header} has no database_name`);
  return name;
}

function wrangler(wranglerArgs) {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  const command = fs.existsSync(bin) ? bin : 'npx';
  const argv = fs.existsSync(bin) ? wranglerArgs : ['wrangler', ...wranglerArgs];
  const envFlag = ENV_NAME === 'production' ? [] : ['--env', ENV_NAME];
  const res = spawnSync(command, [...argv, '--config', WRANGLER_CONFIG, ...envFlag], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CI: 'true',
      WRANGLER_SEND_METRICS: 'false',
      NO_COLOR: '1',
    },
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status !== 0) throw new Error(`wrangler ${wranglerArgs.join(' ')} failed:\n${output.slice(-2000)}`);
  return output;
}

function parseResults(output) {
  const start = output.indexOf('[');
  if (start < 0) throw new Error(`No JSON in wrangler output:\n${output.slice(-800)}`);
  const parsed = JSON.parse(output.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first && first.results) || [];
}

const KEEP = new Set(['d1_migrations', 'sqlite_sequence', '_cf_KV', 'client_settings', 'wht_rates', 'nafdac_catalog', 'users', 'businesses']);
const D1_NAME = databaseName();
console.log(`Formatting ${ENV_NAME} database ${D1_NAME}. The administrator row stays. The PIN is not changed.`);

const tables = parseResults(wrangler([
  'd1', 'execute', D1_NAME, '--remote', '--json',
  '--command', "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
])).map((row) => row.name).filter(Boolean);

const columns = parseResults(wrangler([
  'd1', 'execute', D1_NAME, '--remote', '--json',
  '--command', 'PRAGMA table_info(client_settings)',
])).map((row) => row.name);

const statements = ['PRAGMA foreign_keys = OFF;'];
const settings = [];
for (const column of ['business_name', 'logo_data_url', 'primary_business_id', 'receipt_footer_text']) {
  if (columns.includes(column)) settings.push(`${column} = NULL`);
}
if (settings.length) statements.push(`UPDATE client_settings SET ${settings.join(', ')};`);

for (const name of tables) {
  if (KEEP.has(name) || name.startsWith('_cf_') || name.startsWith('sqlite_')) continue;
  if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
  statements.push(`DELETE FROM ${name};`);
}
statements.push("DELETE FROM users WHERE role <> 'ADMIN';");
statements.push("UPDATE users SET business_id = NULL, branch_id = NULL, updated_at = datetime('now') WHERE role = 'ADMIN';");
statements.push('DELETE FROM businesses;');

const file = path.join(ROOT, '.cache', `format-${ENV_NAME}.sql`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${statements.join('\n')}\n`);
console.log(`Deleting rows from ${statements.length - 1} statements.`);
wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', path.relative(ROOT, file)]);

const users = parseResults(wrangler([
  'd1', 'execute', D1_NAME, '--remote', '--json',
  '--command', "SELECT role, username, business_id FROM users",
]));
const businesses = parseResults(wrangler([
  'd1', 'execute', D1_NAME, '--remote', '--json',
  '--command', 'SELECT COUNT(*) AS n FROM businesses',
]));
console.log(`Users left: ${users.map((row) => `${row.username} (${row.role})`).join(', ') || 'none'}`);
console.log(`Businesses left: ${businesses[0] ? businesses[0].n : 'unknown'}`);
if (users.length !== 1 || String(users[0].role) !== 'ADMIN' || Number(businesses[0] && businesses[0].n) !== 0) {
  console.error('The database is not administrator-only.');
  process.exit(1);
}
console.log(`${ENV_NAME} is administrator-only. PIN unchanged.`);
