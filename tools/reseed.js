'use strict';
// =====================================================================
// tools/reseed.js — REBUILD A DEPLOYMENT WITH ONE ADMIN AND NOTHING ELSE
// =====================================================================
// WHAT THIS IS FOR
//
// Handing a client a working installation of this app. Not a demo, not a
// walkthrough — their own copy, on their own machine or their own Cloudflare
// account, with an empty set of books and one way in.
//
// What it does, in order:
//
//   1. Backs up the existing database file (if there is one) to .data/backups/.
//      A reset is the most destructive thing anybody can run, and the point of a
//      backup is that it exists BEFORE anyone is sure they want it.
//   2. Creates a fresh database and applies every migration.
//   3. Provisions the PLATFORM ONLY: the settings row, the withholding-tax rate
//      schedule as data, and exactly one ADMIN user.
//   4. Prints the sign-in, once.
//
// Everything else — the business, its branches, the chart of accounts, the
// catalogue, the staff, the tills — is created BY THE CLIENT through the app's
// own screens. That is the point: a fresh deployment should not arrive
// pre-filled with somebody else's company.
//
// WHY NOT JUST DELETE ROWS FROM THE EXISTING DATABASE
//
// Because "delete the demo data" is a promise no SQL statement can keep. Every
// demo row has children — a sale has items, payments, ledger entries, stock
// movements, audit rows; a branch has tills, batches, transfers; a business has
// accounts, classes, price lists. Deleting the parents leaves orphans, deleting
// them in the wrong order fails on a foreign key, and the result is a database
// that LOOKS empty and still contains a previous company's numbers in the
// ledger. Rebuilding from migrations is the only version of this that is
// actually true, and it is why the honest tool is "start again" rather than
// "clean up".
//
// USAGE
//   node tools/reseed.js                          # admin / a random PIN
//   node tools/reseed.js --pin=48213              # choose the PIN
//   node tools/reseed.js --username=admin --pin=48213
//   node tools/reseed.js --keep                    # no backup (see below)
//   node tools/reseed.js --db=.data/client.db      # a specific database
//
// Exit code is non-zero if the deployment could not be built, so a deploy
// script stops rather than shipping an installation with no way in.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const { openDatabase, migrate } = require('../server/lib/db');
const { provisionPlatform } = require('../server/services/provisioningService');

// ---------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------
function parseArgs(argv) {
  const out = { username: 'admin', pin: null, keep: false, db: process.env.STOCKRIDGE_DB || null, quiet: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--keep') { out.keep = true; continue; }
    if (arg === '--quiet') { out.quiet = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === 'username') out.username = value;
    else if (key === 'pin') out.pin = value;
    else if (key === 'db') out.db = value;
  }
  return out;
}

/** A PIN somebody can actually read off a screen and type on a phone. */
function randomPin() {
  const { randomInt } = require('node:crypto');
  // Five digits: enough entropy for a counter device that also throttles failed
  // attempts, short enough to be typed on a phone without swearing.
  return String(randomInt(10000, 99999));
}

/** Copy the database (and any WAL) aside before it is replaced. */
function backupDatabase(file) {
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.basename(file);
  const made = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const from = file + suffix;
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir, `${stamp}-${base}${suffix}`);
    fs.copyFileSync(from, to);
    made.push(to);
  }
  return made;
}

async function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(__dirname, '..');
  const file = path.resolve(root, args.db || path.join('.data', 'stockridge.db'));
  const pin = String(args.pin || randomPin());
  const username = String(args.username || 'admin').trim().toLowerCase();

  if (!/^\d{4,}$/.test(pin)) {
    console.error(`\n  "${pin}" is not a usable PIN. Use digits only, at least four of them.\n`);
    process.exit(1);
  }
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    console.error(`\n  "${username}" is not a usable username. Lower-case letters, digits, dot, dash or underscore.\n`);
    process.exit(1);
  }

  const log = (...parts) => { if (!args.quiet) console.log(...parts); };

  log('');
  log('  StockRidge — reseed');
  log('  ───────────────────────────────────────────────');
  log(`  database : ${file}`);

  // ---- 1. back up first, and say where it went
  let backups = [];
  if (fs.existsSync(file)) {
    if (args.keep) {
      log('  backup   : skipped (--keep)');
    } else {
      backups = backupDatabase(file);
      log(`  backup   : ${backups.length ? backups[0] : 'nothing to back up'}`);
    }
    // Remove the live database, its write-ahead log and its shared-memory file
    // together. Deleting only the .db leaves a WAL that SQLite will replay into
    // the NEW database — which is how a "fresh" install grows yesterday's data.
    for (const suffix of ['', '-wal', '-shm']) {
      const target = file + suffix;
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });

  // ---- 2. a fresh database, every migration applied
  const db = openDatabase({ file });
  await migrate(db);
  log(`  schema   : ${await countTables(db)} tables`);

  // ---- 3. the platform, and one administrator
  const result = await provisionPlatform(db, { adminUsername: username, adminPin: pin });
  const rates = await db.scalar('SELECT COUNT(*) FROM wht_rates');
  log(`  wht      : ${rates} rate(s) seeded as data (editable by the owner)`);

  // ---- 4. prove it, on the same connection, before declaring success
  const admin = await db.first('SELECT id, username, role, business_id, branch_id, is_active FROM users WHERE username = ? AND is_deleted = 0', [username]);
  if (!admin || admin.role !== 'ADMIN' || !admin.is_active) {
    console.error('\n  FAILED — the administrator row was not created. Nothing else was written.\n');
    process.exit(1);
  }

  const businesses = await db.scalar('SELECT COUNT(*) FROM businesses WHERE is_deleted = 0');
  const branches = await db.scalar('SELECT COUNT(*) FROM branches WHERE is_deleted = 0');
  const others = await db.scalar("SELECT COUNT(*) FROM users WHERE is_deleted = 0 AND username <> ?", [username]);
  const products = await db.scalar('SELECT COUNT(*) FROM products WHERE is_deleted = 0');

  db.close();

  log('');
  log('  Result');
  log('  ───────────────────────────────────────────────');
  log(`  administrator : ${username}   (role ADMIN, no business, no branch)`);
  log(`  businesses    : ${businesses}`);
  log(`  branches      : ${branches}`);
  log(`  products      : ${products}`);
  log(`  other users   : ${others}`);
  log('');
  log('  Sign in');
  log('  ───────────────────────────────────────────────');
  log(`    username : ${username}`);
  log(`    PIN      : ${pin}`);
  log('');
  log('  This PIN is shown once and is stored hashed — write it down now.');
  log('  Change it after the first sign-in (My account → Change my PIN).');
  log('');
  log('  On a fresh deployment the administrator\'s job is:');
  log('    1. Businesses → Create a business, choosing the vertical');
  log('       (electronics, furniture, wholesale, building materials).');
  log('       Provisioning builds the categories, the chart of accounts,');
  log('       the customer classes, the price lists and a starter catalogue.');
  log('    2. Staff → Add the owner, then a manager and staff per branch.');
  log('    3. Branches → set each shop\'s clock-in fence.');
  log('    4. Settings → confirm the VAT rate and the staff controls.');
  log('    5. Sign out, and hand the owner their username and PIN.');
  log('');

  if (backups.length) log(`  Previous data (if you need it): ${backups[0]}`);
  log('');

  // A machine-readable line for deploy scripts, so nobody has to parse prose.
  console.log(`STOCKRIDGE_RESEED ok=1 db=${file} username=${username} pin=${pin} admin=${result.created ? 'created' : 'existing'}`);
}

async function countTables(db) {
  const row = await db.first("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return Number(row && row.n) || 0;
}

main().catch((err) => {
  console.error('\n  reseed failed:', err && err.message ? err.message : err);
  if (err && err.stack && process.env.STOCKRIDGE_DEBUG) console.error(err.stack);
  console.error('');
  process.exit(1);
});
