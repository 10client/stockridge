'use strict';
// =====================================================================
// tools/deploy-cloudflare.js — DEPLOY THE WHOLE STACK TO CLOUDFLARE
// =====================================================================
// One command that takes a clean checkout to a running deployment:
//
//   1. verify the API token and resolve the account id
//   2. create the D1 database if it does not exist
//   3. apply the migrations  (the same .sql files the Node backend applies)
//   4. seed ONE administrator and nothing else, idempotently
//   5. set the Worker's JWT secret, generated here, printed once
//   6. deploy the Worker, which serves BOTH the API and the PWA
//   7. smoke-test the deployment: health, readiness, sign-in, and that the
//      seeded administrator can actually be used
//
// WHY IT IS A SCRIPT AND NOT A LIST OF COMMANDS IN A README
//
// Because step 7 is the point. A deploy that reports success and leaves an
// administrator who cannot sign in is worse than a deploy that fails loudly —
// and the only way to know the difference is to sign in. Every step here is
// idempotent: the seed uses INSERT OR IGNORE, the migrations are tracked by D1,
// and deploying a Worker that is already deployed is a no-op update.
//
// CREDENTIALS
//
// Read from the environment, or from .env.deploy (which is gitignored):
//
//   CLOUDFLARE_API_TOKEN   required
//   CLOUDFLARE_ACCOUNT_ID  optional — resolved from the token if absent
//   STOCKRIDGE_ADMIN_PIN   optional — a random one is generated and printed
//
// USAGE
//   node tools/deploy-cloudflare.js                 # everything
//   node tools/deploy-cloudflare.js --dry-run       # stop before the deploy
//   node tools/deploy-cloudflare.js --skip-seed     # do not touch the admin row
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

// Argument parsing comes first: the environment decides the database name and the
// config section below, so it has to exist before they are computed.
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const ROOT = path.resolve(__dirname, '..');
const WRANGLER_CONFIG = path.join('worker', 'wrangler.toml');

// ---------------------------------------------------------------------
// WHICH ENVIRONMENT
//
// `--env=sample` targets the `[env.sample]` block in wrangler.toml: its own
// Worker name (and therefore its own *.workers.dev URL) and its own D1 database.
// Without it, the top-level configuration is deployed — which is production.
//
// This matters more than it looks. Every wrangler command below the top level
// needs `--env` or it cannot see a binding declared inside an environment, and
// the failure reads "Couldn't find a D1 DB with the name or binding 'x' in your
// wrangler.toml file" — which sounds like a missing binding rather than a missing
// flag.
// ---------------------------------------------------------------------
const ENV_NAME = valueOf('--env');
const IS_DEFAULT_ENV = !ENV_NAME;
const ENV_FLAG = ENV_NAME ? ['--env', ENV_NAME] : [];

/**
 * Refuse an environment name that wrangler.toml does not define.
 *
 * `--env=prod` is a natural thing to type when the block is called
 * `[env.production]`, and nothing below the top level complains: wrangler cannot
 * see a binding declared inside an environment it was not given, this script
 * derives the database NAME from the environment name (`stockridge-prod`), finds
 * no database by that name, and CREATES one — a brand-new, empty D1 database that
 * no Worker points at, while the real production database sits untouched and the
 * run fails later at a migration with a message about migrations.
 *
 * So the name is checked against the file before anything is created. The list of
 * real environments is printed, because the fix is a one-word correction.
 */
function declaredEnvironments() {
  const file = path.join(ROOT, WRANGLER_CONFIG);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^\[env\.([A-Za-z0-9_-]+)\]$/gm)].map((m) => m[1]);
}

if (ENV_NAME && !declaredEnvironments().includes(ENV_NAME)) {
  const known = declaredEnvironments();
  console.error(`\n  --env=${ENV_NAME} is not an environment in ${WRANGLER_CONFIG}.`);
  console.error(known.length
    ? `  It declares: ${known.join(', ')}.\n  Omit --env entirely to deploy production (the top-level configuration).\n`
    : `  It declares none, so the top-level configuration is production.\n`);
  process.exit(1);
}

/**
 * The database this environment binds — read from wrangler.toml, never derived.
 *
 * It used to be computed as `stockridge-${ENV_NAME}`, which is right for staging
 * and sample and WRONG for production, whose database is called `stockridge`
 * because it was created first, before there was anything to distinguish it from.
 * So `--env=production` looked for a database named `stockridge-production`,
 * created one when it found none, and rewrote the production binding to point at
 * the empty one — while the real production database sat there untouched. The
 * file says which database an environment uses; that is the only answer that is
 * true for every environment, and it is the one place a name is written down.
 */
function databaseNameForEnvironment() {
  const file = path.join(ROOT, WRANGLER_CONFIG);
  const text = fs.readFileSync(file, 'utf8');
  const header = ENV_NAME ? `[[env.${ENV_NAME}.d1_databases]]` : '[[d1_databases]]';
  const sections = text.split(/(?=^\[)/m);
  const section = sections.find((part) => String(part.split('\n')[0] || '').trim() === header);
  if (!section) {
    throw new Error(`${header} is missing from ${WRANGLER_CONFIG}, so this deployment has no database to bind.`);
  }
  const name = (section.match(/database_name\s*=\s*"([^"]*)"/) || [])[1];
  if (!name) {
    throw new Error(`${header} in ${WRANGLER_CONFIG} has no database_name, so there is no way to tell which database this deployment uses.`);
  }
  return name;
}

const D1_NAME = databaseNameForEnvironment();

// ---------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------
function loadEnvFile() {
  const file = path.join(ROOT, '.env.deploy');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key]) continue;
    const value = raw.replace(/^["']|["']$/g, '');
    if (value) process.env[key] = value;
  }
}
loadEnvFile();

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;
let ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || null;
const ADMIN_USERNAME = process.env.STOCKRIDGE_ADMIN_USERNAME || 'admin';
const ADMIN_PIN = valueOf('--pin') || process.env.STOCKRIDGE_ADMIN_PIN || randomPin();

const CF_API = 'https://api.cloudflare.com/client/v4';

function randomPin() {
  return String(10000 + (randomBytes(2).readUInt16BE(0) % 90000));
}

function log(step, message) {
  console.log(`\n[${step}] ${message}`);
}
function warn(message) { console.log(`      ! ${message}`); }
function ok(message) { console.log(`      ✓ ${message}`); }

async function cf(pathname, init = {}) {
  const res = await fetch(`${CF_API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

function wrangler(wranglerArgs, { input = null, allowFailure = false } = {}) {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  const command = fs.existsSync(bin) ? bin : 'npx';
  const argv = fs.existsSync(bin) ? wranglerArgs : ['wrangler', ...wranglerArgs];
  const res = spawnSync(command, argv, {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID || '',
      CI: 'true',
      WRANGLER_SEND_METRICS: 'false',
      NO_COLOR: '1',
    },
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`wrangler ${wranglerArgs.join(' ')} failed:\n${output.slice(-2500)}`);
  }
  return { status: res.status, output };
}

// ---------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------
async function verifyToken() {
  log('1/7', 'Verifying the Cloudflare token');
  if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is not set. Put it in .env.deploy or export it.');

  // /user/tokens/verify rejects account-scoped tokens that work perfectly well
  // for Workers and D1, so the real test is whether the accounts endpoint
  // answers — that is the permission every step below needs.
  const accounts = await cf('/accounts');
  if (!accounts.json.success) {
    throw new Error(`The token was refused: ${JSON.stringify(accounts.json.errors || accounts.json).slice(0, 300)}`);
  }
  const list = accounts.json.result || [];
  if (!list.length) throw new Error('The token is valid but can see no accounts. Check its scope.');

  if (!ACCOUNT_ID) ACCOUNT_ID = list[0].id;
  const match = list.find((a) => a.id === ACCOUNT_ID);
  if (!match) throw new Error(`Account ${ACCOUNT_ID} is not visible to this token. Visible: ${list.map((a) => `${a.name} (${a.id})`).join(', ')}`);
  ok(`account: ${match.name} (${ACCOUNT_ID})`);
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
  return match;
}

async function ensureDatabase() {
  log('2/7', `Ensuring the D1 database "${D1_NAME}" exists`);
  const list = await cf(`/accounts/${ACCOUNT_ID}/d1/database`);
  const existing = (list.json.result || []).find((d) => d.name === D1_NAME);
  if (existing) {
    ok(`already exists: ${existing.uuid} (${existing.num_tables || 0} tables)`);
    return existing.uuid;
  }
  const created = await cf(`/accounts/${ACCOUNT_ID}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name: D1_NAME }),
  });
  if (!created.json.success) throw new Error(`Could not create the database: ${JSON.stringify(created.json.errors).slice(0, 300)}`);
  ok(`created: ${created.json.result.uuid}`);
  return created.json.result.uuid;
}

function configPath() { return path.join(ROOT, WRANGLER_CONFIG); }

/**
 * Put the database id into wrangler.toml, where it is required.
 *
 * Rewrites rather than only fills in a blank: a database that was deleted and
 * recreated comes back with a NEW uuid, and a stale id binds the deployment to a
 * database nobody can see. Rewriting is idempotent.
 *
 * IT TOUCHES EXACTLY ONE SECTION, and which one depends on where it is deploying.
 *
 * The first version replaced every `database_id` in the file — correct while
 * every environment shared one database, and a silent disaster once they did not:
 * a routine production deploy would have repointed staging at real sales. The
 * second version hard-coded "top level and production", which is right for a
 * production deploy and wrong for every other environment. This one derives the
 * section from the environment being deployed, which is the only thing that is
 * true in general.
 */
function dbSectionHeader() {
  return ENV_NAME ? `[[env.${ENV_NAME}.d1_databases]]` : '[[d1_databases]]';
}

function writeDatabaseId(databaseId) {
  const file = configPath();
  const text = fs.readFileSync(file, 'utf8');
  const target = dbSectionHeader();

  // The whole first line of each section, trimmed. A regex like `/^\[[^\]]*\]/`
  // stops at the first `]`, so it reads `[[d1_databases]]` as `[[d1_databases]`
  // and then matches nothing at all — a silent no-op that reports success.
  const sections = text.split(/(?=^\[)/m);
  let changed = 0;
  const others = [];

  const updated = sections.map((section) => {
    const header = String(section.split('\n')[0] || '').trim();

    if (header === target) {
      const next = section.replace(/(database_id\s*=\s*)"[^"]*"/g, (match, prefix) => {
        changed += 1;
        return `${prefix}"${databaseId}"`;
      });
      if (changed === 0) {
        // The section exists but has no database_id line to rewrite: created by
        // hand and left incomplete. Say so rather than deploying against nothing.
        throw new Error(`The ${target} block in ${WRANGLER_CONFIG} has no database_id line to set.`);
      }
      return next;
    }

    if (/^\[\[env\.[a-z0-9_-]+\.d1_databases\]\]$/i.test(header)) {
      const name = (section.match(/database_name\s*=\s*"([^"]*)"/) || [])[1];
      const id = (section.match(/database_id\s*=\s*"([^"]*)"/) || [])[1];
      others.push(`${header.replace(/^\[\[env\.|\.d1_databases\]\]$/g, '')} → ${name || 'unnamed'} (${id || 'unset'})`);
    }
    return section;
  }).join('');

  if (changed === 0) {
    // This function's own comment warns about a silent no-op that reports
    // success, and that is exactly what it did: with no matching section the
    // write was skipped and "database_id set" printed anyway. Reachable before
    // the environment check above existed, and worth keeping as the last line of
    // defence — a deploy that cannot bind its database must not proceed.
    throw new Error(`The ${target} block in ${WRANGLER_CONFIG} has no database_id line to rewrite, so the deployment would not be bound to the database it just prepared.`);
  }
  if (updated !== text) fs.writeFileSync(file, updated);
  ok(`database_id set for ${ENV_NAME ? `env "${ENV_NAME}"` : 'the default (production)'} in ${WRANGLER_CONFIG}`);
  if (others.length) ok(`other environments untouched: ${others.join('; ')}`);
  if (others.some((o) => o.includes(databaseId))) {
    warn('one of those environments points at THIS database — a sample or staging environment sharing production data is not a separate environment.');
  }
}

/**
 * Ask the deployment itself whether an administrator already exists.
 *
 * This decides whether the PIN this run generates is the PIN that will work. The
 * seed is INSERT OR IGNORE, so on a redeploy the existing row — and the client's
 * changed PIN — is deliberately left alone. A summary that prints a fresh PIN in
 * that case is worse than printing none: the operator writes it down, hands it to
 * the client, and it fails.
 */
function administratorExists() {
  const res = wrangler(['d1', 'execute', D1_NAME, '--remote', '--config', WRANGLER_CONFIG, ...ENV_FLAG,
    "--command=SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND is_deleted = 0 AND is_active = 1",
    '--json'], { allowFailure: true });
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.output.slice(res.output.indexOf('[')));
    const row = parsed[0] && parsed[0].results && parsed[0].results[0];
    return row && row.n != null ? Number(row.n) : null;
  } catch (e) {
    return null;
  }
}

function applyMigrations() {
  log('3/7', 'Applying migrations to D1 (the same .sql files Node applies)');
  const res = wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote', '--config', WRANGLER_CONFIG, ...ENV_FLAG]);
  const summary = (res.output.match(/Migrations? to be applied:[\s\S]*?(?=\n\n|$)/) || [res.output.match(/No migrations to apply\.|✅[^\n]*/) || []])[0];
  ok(String(summary || 'applied').trim().split('\n').slice(0, 12).join('\n      '));
}

function seedAdministrator() {
  log('4/7', 'Seeding ONE administrator and nothing else');
  if (has('--skip-seed')) { warn('skipped (--skip-seed)'); return { pinEffective: null }; }

  const existing = administratorExists();
  const resetPin = has('--reset-pin');
  if (existing === null) {
    warn('could not read the administrator count from D1; the PIN below may not be the effective one');
  } else if (existing > 0 && !resetPin) {
    warn(`this deployment already has ${existing} administrator(s) — their PIN is left unchanged`);
    warn('pass --reset-pin to set a new PIN (this OVERWRITES the existing one)');
  }

  const seedFile = path.join(ROOT, '.data', 'd1-seed.sql');
  const seedArgs = [
    path.join(ROOT, 'tools', 'd1-seed.js'),
    `--out=${path.relative(ROOT, seedFile)}`,
    `--username=${ADMIN_USERNAME}`,
    `--pin=${ADMIN_PIN}`,
  ];
  if (resetPin) seedArgs.push('--reset');
  const gen = spawnSync(process.execPath, seedArgs, { cwd: ROOT, encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(`d1-seed failed:\n${gen.stderr || gen.stdout}`);
  ok('seed SQL generated (settings row, withholding rates, one ADMIN)');

  const res = wrangler(['d1', 'execute', D1_NAME, '--remote', '--config', WRANGLER_CONFIG, ...ENV_FLAG, `--file=${path.relative(ROOT, seedFile)}`]);
  const tail = res.output.replace(/\s+/g, ' ');
  const wrote = (tail.match(/rows_written\W+(\d+)/) || [])[1];
  ok(`executed against D1${wrote != null ? ` (${wrote} row(s) written)` : ''}`);

  // The PIN this run generated is only THE pin when it is the one that was
  // actually stored: either the deployment had no administrator, or --reset-pin
  // rewrote the row on purpose.
  const pinEffective = resetPin || existing === 0 ? true : (existing === null ? null : false);
  return { pinEffective };
}

function setJwtSecret() {
  log('5/7', 'Setting the Worker JWT secret');
  // Generated here rather than left to the platform: without it the Worker
  // derives a fallback, which works but signs every device out if the derivation
  // ever changes. A stable secret is what keeps a 12-hour shop-day token valid
  // across a deploy.
  const existing = process.env.STOCKRIDGE_JWT_SECRET || randomBytes(48).toString('base64url');
  const res = wrangler(['secret', 'put', 'JWT_SECRET', '--config', WRANGLER_CONFIG, ...ENV_FLAG], { input: `${existing}\n` });
  if (/error/i.test(res.output) && !/Success/i.test(res.output)) warn(res.output.slice(-300));
  else ok('JWT_SECRET set (generated for this deployment)');
  return existing;
}

function deployWorker() {
  log('6/7', 'Deploying the Worker (API + PWA from one deployment)');
  if (has('--dry-run')) { warn('dry run: not deploying'); return null; }
  const res = wrangler(['deploy', '--config', WRANGLER_CONFIG, ...ENV_FLAG]);
  const url = (res.output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/) || [])[0] || null;
  const size = (res.output.match(/Total Upload: [^\n]+/) || [])[0];
  ok(size || 'uploaded');
  ok(url ? `live at ${url}` : 'deployed');
  if (!url) warn(`Could not read the URL from the output:\n${res.output.slice(-600)}`);
  return url;
}

async function smokeTest(baseUrl, { pinEffective = null } = {}) {
  log('7/7', 'Smoke-testing the deployment');
  if (!baseUrl) { warn('no URL to test'); return { ok: false }; }
  const problems = [];
  const results = { url: baseUrl };

  const get = async (p) => {
    const res = await fetch(`${baseUrl}${p}`, { headers: { Accept: 'application/json' } });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch (e) { json = null; }
    return { status: res.status, json };
  };

  // ---- IDENTITY FIRST: is the thing answering this URL OUR deployment?
  //
  // A *.workers.dev URL is a stable name, so a deploy can be answered by the
  // PREVIOUS version — or, on an account that already had a Worker with this
  // name, by a completely different application. Both happened: a fixed
  // deployment was reported as still broken, and then `sample` was reported as
  // failing sign-in when the legacy Worker of that name was still warm at this
  // edge and had no /api/auth/login at all.
  //
  // Waiting on "did it answer" is not enough. This waits on "did OUR code
  // answer", identified by the runtime marker and the PIN round-trip check that
  // only this application has, and says plainly what answered when it gives up.
  const isOurs = (res) => res.status === 200 && res.json
    && res.json.runtime === 'cloudflare-workers'
    && Array.isArray(res.json.checks)
    && res.json.checks.some((c) => c.name === 'PIN hashing round-trip');

  let diagnose = await get('/api/diagnose');
  for (let attempt = 2; attempt <= 8 && !isOurs(diagnose); attempt += 1) {
    const who = diagnose.json && diagnose.json.service ? `"${diagnose.json.service}"` : `HTTP ${diagnose.status}`;
    console.log(`      … this URL is answering as ${who}, not StockRidge yet (attempt ${attempt}/8), waiting 15s`);
    await new Promise((r) => { setTimeout(r, 15000); });
    diagnose = await get('/api/diagnose');
  }
  results.diagnose = diagnose.json;

  if (!isOurs(diagnose)) {
    const who = diagnose.json && diagnose.json.service
      ? `Another application named "${diagnose.json.service}"`
      : `HTTP ${diagnose.status} with no StockRidge markers`;
    problems.push(`the URL ${baseUrl} is not answering as this deployment: ${who}. `
      + 'Either the new version has not reached this edge yet, or another Worker owns this name.');
  } else {
    const checks = diagnose.json.checks;
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      problems.push(`/api/diagnose: ${failed.map((c) => `${c.name}${c.error ? `: ${c.error}` : ''}`).join(' | ')}`);
    } else {
      const health = await get('/api/health');
      ok(health.status === 200 ? `health: up (${health.json.service})` : `health: HTTP ${health.status}`);
      ok(`readiness: ${checks.length} checks pass (schema, migrations, administrator, PIN hashing, sign-in lookup)`);
    }
  }

  // Readiness is a lifecycle report, not a pass/fail: a handover deployment is
  // legitimately NOT ready to trade until the client creates their business.
  const ready = await get('/api/health/ready');
  results.readiness = ready.json;
  if (ready.json && ready.json.status === 'awaiting_first_business') {
    ok('readiness: awaiting the first business — this is the expected handover state');
  } else if (ready.status === 200) {
    ok(`readiness: ready (${ready.json && ready.json.businesses} business(es) trading)`);
  } else {
    problems.push(`/api/health/ready → ${ready.status}: ${JSON.stringify(ready.json && ready.json.problems).slice(0, 240)}`);
  }

  const app = await fetch(`${baseUrl}/`);
  const html = await app.text();
  if (app.status !== 200 || !/StockRidge/i.test(html)) problems.push(`the PWA did not load (${app.status})`);
  else ok('the PWA is served from the same deployment');

  const sw = await fetch(`${baseUrl}/sw.js`);
  if (sw.status !== 200) problems.push(`/sw.js → ${sw.status} (the service worker will not register)`);
  else ok('service worker served');

  // When the seed did not rewrite the administrator row, the PIN in this run's
  // summary is NOT the stored one, so a 401 proves nothing about the deployment
  // and reporting it as a problem sends the operator hunting for a fault that
  // is really this script's own lack of knowledge.
  if (pinEffective === false || pinEffective === null) {
    warn('sign-in not tested: the stored administrator PIN is not known to this run');
    warn('to verify end to end, re-run with --reset-pin (or the PIN you set earlier)');
    results.problems = problems;
    results.ok = problems.length === 0;
    return results;
  }

  const attemptLogin = async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USERNAME, pin: ADMIN_PIN }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let login = await attemptLogin();
  // Same propagation delay as the diagnose call above: a 401 immediately after a
  // deploy is more likely to be the previous version answering than a bad PIN,
  // and telling the operator their PIN is wrong when it is not is the worst
  // possible first impression of the deployment.
  if (login.status === 401) {
    console.log('      … sign-in refused; the previous version may still be live here, retrying in 15s');
    await new Promise((r) => { setTimeout(r, 15000); });
    login = await attemptLogin();
  }
  const loginBody = login.body;
  if (login.status !== 200 || !loginBody || !loginBody.token) {
    problems.push(`sign-in failed (${login.status}): ${JSON.stringify(loginBody).slice(0, 200)}`);
  } else {
    ok(`sign-in works as ${ADMIN_USERNAME}`);

    // And the administrator can see the screens a first-time client needs.
    //
    // These retry on 401 for the same reason the sign-in does: this deploy may
    // have just rotated JWT_SECRET, and during the rollout a token can be issued
    // by one isolate and checked by another. A 401 here means "try again in a
    // moment", not "the deployment is broken".
    const screens = ['/api/auth/me', '/api/businesses', '/api/profiles', '/api/plan'];
    const checkScreens = async (bearer) => {
      const bad = [];
      for (const p of screens) {
        const res = await fetch(`${baseUrl}${p}`, { headers: { Authorization: `Bearer ${bearer}` } });
        if (res.status !== 200) bad.push(`${p} → ${res.status}`);
      }
      return bad;
    };
    let screenProblems = await checkScreens(loginBody.token);
    if (screenProblems.some((p) => p.includes('401'))) {
      console.log('      … a first-run screen answered 401 during the rollout, signing in again');
      await new Promise((r) => { setTimeout(r, 15000); });
      const again = await attemptLogin();
      if (again.status === 200 && again.body && again.body.token) {
        screenProblems = await checkScreens(again.body.token);
      }
    }
    for (const problem of screenProblems) problems.push(problem);
    if (screenProblems.length === 0) ok('the administrator can reach the first-run screens');
  }

  results.problems = problems;
  results.ok = problems.length === 0;
  return results;
}

async function main() {
  console.log('StockRidge — Cloudflare deployment');
  console.log(`  target: ${ENV_NAME ? `environment "${ENV_NAME}"` : 'production (the default configuration)'}`);
  console.log('──────────────────────────────────────────────────────────');

  // STAMP THE BUILD BEFORE ANYTHING IS UPLOADED. The service worker names its cache after this
  // stamp and serves assets cache-first, so a deploy that does not bump it hands every browser
  // that has already visited the build it already has — the new files land on the server and
  // never reach the screen. See tools/stamp-build.js.
  const stamped = require('./stamp-build').stamp();
  console.log(`  build stamp   : ${stamped.stampValue}${stamped.changed.length ? '' : ' (unchanged)'}`);
  for (const f of stamped.changed) console.log(`                  updated ${f}`);

  await verifyToken();
  const databaseId = await ensureDatabase();
  writeDatabaseId(databaseId);
  applyMigrations();
  const seeding = seedAdministrator();
  setJwtSecret();
  const url = deployWorker();

  let smoke = { ok: false, problems: ['not run'] };
  if (url) smoke = await smokeTest(url, { pinEffective: seeding.pinEffective });

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('Deployment summary');
  console.log(`  account       : ${ACCOUNT_ID}`);
  console.log(`  environment   : ${ENV_NAME || 'production (default)'}`);
  console.log(`  D1 database   : ${D1_NAME} (${databaseId})`);
  console.log(`  Worker        : ${url || '(dry run)'}`);
  const lifecycle = smoke.readiness && smoke.readiness.status;
  if (lifecycle) console.log(`  readiness     : ${lifecycle}`);
  console.log(`  administrator : ${ADMIN_USERNAME}`);
  if (seeding.pinEffective === true) {
    console.log(`  PIN           : ${ADMIN_PIN}`);
  } else if (seeding.pinEffective === false) {
    console.log('  PIN           : unchanged — this deployment already had an administrator.');
    console.log('                  The PIN above is NOT in effect. To set a new one, re-run with --reset-pin.');
  } else {
    console.log(`  PIN           : ${ADMIN_PIN} (unverified — could not read the administrator count)`);
  }
  console.log('');

  if (!smoke.ok) {
    console.log('  SMOKE TEST PROBLEMS');
    for (const p of smoke.problems || []) console.log(`    - ${p}`);
  } else {
    console.log('  All checks passed. Sign in and create the first business:');
    console.log('    Businesses → Create a business → choose the vertical.');
    console.log('  Provisioning builds the chart of accounts, categories, customer');
    console.log('  classes, price lists and a starter catalogue for that vertical.');
  }
  console.log('');
  if (seeding.pinEffective === true) console.log('  This PIN is shown once. Only its hash is stored.');
  console.log('');

  process.exit(smoke.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('\nDeployment failed:', err && err.message ? err.message : err);
  process.exit(1);
});
