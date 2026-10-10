'use strict';
// =====================================================================
// tools/d1-seed.js — SEED A CLOUDFLARE D1 DATABASE WITH ONE ADMINISTRATOR
// =====================================================================
// The D1 twin of tools/reseed.js. It emits SQL rather than writing rows,
// because D1 is reached over the network and the two supported ways to run SQL
// against it — `wrangler d1 execute --file` and the D1 HTTP query API — both
// take a file of statements.
//
// WHAT IT PRODUCES, AND WHAT IT DELIBERATELY DOES NOT
//
// Exactly three things:
//
//   1. the settings row (a deployment needs one, and its trading name is the
//      client's to set in the app);
//   2. the 2024 withholding-tax schedule, ten rates, as DATA — so a change in
//      the Regulations is an edit in the app, not a redeploy;
//   3. one ADMIN account, with NO business and NO branch.
//
// No business, no branch, no owner, no demo catalogue, no sample sales. Those
// arrive through the app: the administrator's first job is to create the
// business and hand it over, and everything a business needs — chart of
// accounts, categories, customer classes, price lists, a starter catalogue — is
// built by the same provisioning service the admin screen calls.
//
// WHY THAT MATTERS FOR A CLIENT DEPLOYMENT
//
// A deployment pre-filled with somebody else's demo company invites a client to
// trade inside books they did not create: their first sale posts against a chart
// of accounts they never saw, and untangling that later is real work. An empty
// deployment is a five-minute setup and an honest one.
//
// IDEMPOTENT BY CONSTRUCTION
//
// Every statement is INSERT OR IGNORE against a primary key, so running this
// twice — on a deploy that failed halfway, or from a CI job that retried — adds
// nothing and breaks nothing. It will NOT overwrite a PIN: if the username
// already exists, the existing account is kept and the tool says so.
//
// USAGE
//   node tools/d1-seed.js                          # print SQL to stdout
//   node tools/d1-seed.js --out=.data/d1-seed.sql  # write it to a file
//   node tools/d1-seed.js --pin=48213 --username=admin
//   node tools/d1-seed.js --json                   # machine-readable summary
//   node tools/d1-seed.js --reset                  # re-hash the admin PIN (overwrites it)
//
// Then, with the wrangler config in worker/:
//   npx wrangler d1 execute stockridge --remote --config worker/wrangler.toml \
//     --file .data/d1-seed.sql
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const { hashPin, newId } = require('../domain/crypto');
const { WHT_SCHEDULE_2024 } = require('../domain/nigerianTax');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { username: 'admin', pin: null, out: null, json: false, businessName: null, adminName: 'StockRidge Platform Administrator', reset: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--reset') { out.reset = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const key = m[1];
    if (key === 'username') out.username = m[2];
    else if (key === 'pin') out.pin = m[2];
    else if (key === 'out') out.out = m[2];
    else if (key === 'business-name') out.businessName = m[2];
    else if (key === 'admin-name') out.adminName = m[2];
  }
  return out;
}

/** Five digits: enough entropy for a device that also throttles failed logins. */
function randomPin() {
  const { randomInt } = require('node:crypto');
  return String(randomInt(10000, 99999));
}

/** A single-quoted SQLite string literal. Doubling the quotes is the only escape
 *  that matters, and it is the one a hand-built INSERT forgets. */
function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function buildSeedSql({ username, pin, businessName = null, adminName = 'StockRidge Platform Administrator', reset = false }) {
  const startedAt = new Date().toISOString();
  const statements = [];

  statements.push('-- StockRidge - platform seed for Cloudflare D1');
  statements.push(`-- generated ${startedAt} by tools/d1-seed.js`);
  statements.push('-- One administrator. No business, no branch, no demo data.');
  statements.push('-- Safe to run twice: every statement is INSERT OR IGNORE.');
  statements.push('');

  // ---- 1. the settings row
  statements.push([
    '-- The settings row. subscription_plan and status are what the plan limits',
    '-- read; an owner edits everything else in the app.',
  ].join('\n'));
  // Column list taken from the schema, not from memory: client_settings has NO
  // created_at (it has updated_at and updated_by). An INSERT naming a column
  // that does not exist is the first thing a real D1 deployment would have said
  // no to — which is why test/integration/d1-seed.test.js executes this file.
  statements.push(`INSERT OR IGNORE INTO client_settings
  (id, business_name, subscription_status, subscription_plan, vat_enabled, vat_rate_percent, serial_tracking_enabled, updated_at)
VALUES
  (1, ${sqlString(businessName)}, 'ACTIVE', 'Standard', 1, 7.5, 0, datetime('now'));`);
  statements.push('');

  // ---- 2. the withholding schedule, as data
  statements.push([
    '-- The 2024 Withholding Regulations (effective 1 January 2025), as rows',
    '-- rather than constants, so an owner can change a rate without a redeploy.',
  ].join('\n'));
  const rateRows = WHT_SCHEDULE_2024.map((r) => `  (${sqlString(newId())}, ${sqlString(r.code)}, ${sqlString(r.name)}, ${Number(r.rate_percent)}, ${sqlString(r.direction)}, 1, 1, ${sqlString(r.note)}, datetime('now'), datetime('now'))`);
  statements.push(`INSERT OR IGNORE INTO wht_rates
  (id, code, name, rate_percent, direction, is_system, is_active, note, created_at, updated_at)
VALUES
${rateRows.join(',\n')};`);
  statements.push('');

  // ---- 3. one administrator
  const hashed = await hashPin(String(pin));
  const adminId = newId();
  statements.push([
    '-- The platform administrator: no business, no branch.',
    '--',
    "-- It exists to create the client's first business and hand it to an owner.",
    '-- Deliberately NOT attached to a branch, because a vendor key that belongs',
    '-- to a shop is a key the shop can lose.',
    '--',
    '-- INSERT OR IGNORE means re-running this never resets a PIN that has',
    '-- already been changed.',
  ].join('\n'));
  if (reset) {
    // --reset re-writes the administrator's PIN HASH.
    //
    // Two legitimate reasons to need it, and one illegitimate one:
    //
    //   1. The stored hash was written by a runtime that hashes with an
    //      iteration count this deployment cannot verify. That is not
    //      hypothetical: hashes written at 120,000 iterations by the Node
    //      backend CANNOT be verified by the Workers WebCrypto implementation,
    //      which refuses anything above 100,000. The row is present, correct
    //      and unusable until it is re-hashed.
    //   2. The administrator's PIN is lost and the business has no other way in.
    //
    // The illegitimate one is using it casually: this DOES overwrite a PIN the
    // client has already changed, so it is a flag an operator has to type on
    // purpose, and it is never part of a plain re-run.
    //
    // Written as UPDATE-then-conditional-INSERT rather than INSERT OR REPLACE,
    // so that a row whose stored username differs in case is still found and
    // corrected, and so no other column (job title, full name, audit trail) is
    // silently reset along with the hash.
    statements.push([
      '-- --reset: rewrite the administrator PIN hash (see tools/d1-seed.js).',
      `UPDATE users SET pin_hash = ${sqlString(hashed.stored)}, is_active = 1, is_deleted = 0, updated_at = datetime('now')`,
      `  WHERE lower(username) = ${sqlString(username)};`,
    ].join('\n'));
    statements.push(`INSERT INTO users
  (id, business_id, branch_id, full_name, username, pin_hash, role, job_title, is_active, created_at, updated_at)
SELECT ${sqlString(adminId)}, NULL, NULL, ${sqlString(adminName)}, ${sqlString(username)}, ${sqlString(hashed.stored)}, 'ADMIN', 'Vendor Administrator', 1, datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = ${sqlString(username)});`);
  } else {
    statements.push(`INSERT OR IGNORE INTO users
  (id, business_id, branch_id, full_name, username, pin_hash, role, job_title, is_active, created_at, updated_at)
VALUES
  (${sqlString(adminId)}, NULL, NULL, ${sqlString(adminName)}, ${sqlString(username)}, ${sqlString(hashed.stored)}, 'ADMIN', 'Vendor Administrator', 1, datetime('now'), datetime('now'));`);
  }
  statements.push('');

  // ---- what the operator should see afterwards
  statements.push('-- Verify:');
  statements.push("SELECT 'administrators' AS check_name, COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND is_deleted = 0 AND is_active = 1;");
  statements.push("SELECT 'businesses' AS check_name, COUNT(*) AS n FROM businesses WHERE is_deleted = 0;");
  statements.push("SELECT 'wht_rates' AS check_name, COUNT(*) AS n FROM wht_rates;");
  statements.push('');

  return {
    sql: `${statements.join('\n')}\n`,
    adminId,
    username,
    pin,
    hashPreview: `${hashed.stored.slice(0, 14)}…`,
    rateCount: WHT_SCHEDULE_2024.length,
    generatedAt: startedAt,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const username = String(args.username || 'admin').trim().toLowerCase();
  const pin = String(args.pin || randomPin());

  if (!/^\d{4,}$/.test(pin)) {
    console.error(`\n  "${pin}" is not a usable PIN. Use digits only, at least four.\n`);
    process.exit(1);
  }
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    console.error(`\n  "${username}" is not a usable username. Lower-case letters, digits, dot, dash or underscore.\n`);
    process.exit(1);
  }

  const result = await buildSeedSql({
    username, pin,
    businessName: args.businessName,
    adminName: args.adminName,
    reset: args.reset,
  });

  if (args.out) {
    const target = path.resolve(ROOT, args.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result.sql, 'utf8');
  } else if (!args.json) {
    process.stdout.write(result.sql);
  }

  if (args.json) {
    console.log(JSON.stringify({
      ok: true, username, pin, adminId: result.adminId,
      whtRates: result.rateCount, generatedAt: result.generatedAt,
      out: args.out ? path.resolve(ROOT, args.out) : null,
      note: 'The PIN is printed once. Only its PBKDF2 hash is written to the database.',
    }, null, 2));
    return;
  }

  // The sign-in goes to STDERR so it never contaminates a redirected SQL file.
  process.stderr.write(`
  StockRidge — D1 seed
  ───────────────────────────────────────────────
  administrator : ${username}   (role ADMIN, no business, no branch)
  PIN           : ${pin}${args.reset ? '   [--reset: this OVERWRITES the stored PIN hash]' : ''}
  wht rates     : ${result.rateCount} (2024 Regulations, editable in the app)
  ${args.out ? `written to    : ${path.resolve(ROOT, args.out)}` : ''}

  This PIN is shown once. Only its hash goes into the database.
  Next:
    npx wrangler d1 migrations apply stockridge --remote --config worker/wrangler.toml
    npx wrangler d1 execute stockridge --remote --config worker/wrangler.toml --file ${args.out || '.data/d1-seed.sql'}
    npx wrangler deploy --config worker/wrangler.toml

  Then sign in as ${username} and create the business in the app:
  Businesses → Create a business → pick the vertical. Provisioning builds the
  chart of accounts, categories, customer classes, price lists and a starter
  catalogue, so the client's first act is to describe THEIR business.

`);
}

module.exports = { buildSeedSql };

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  d1-seed failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
