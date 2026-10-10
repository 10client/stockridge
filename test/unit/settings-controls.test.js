'use strict';
// =====================================================================
// test/unit/settings-controls.test.js — A CONTROL THAT CANNOT SAVE IS NOT A CONTROL
// =====================================================================
// The Settings screen is a list of keys in the client and a whitelist of keys in
// the server. When the two disagree, nothing breaks loudly:
//
//   * a control whose key is not a column does not draw at all — the renderer
//     skips keys "this deployment does not have" — so the setting the owner was
//     looking for simply is not on the page;
//   * a route that reads a key which is not a column reads `undefined` and falls
//     through to whatever the code wrote after `||`. That guard never fires, and
//     reads as enforcement while enforcing nothing.
//
// Both had happened. Fifteen of thirty controls named keys that were not columns;
// twenty-nine columns had no control at all; one route read
// `settings.staff_void_requires_manager`, which exists nowhere in the codebase and
// never has; and three policy numbers (`credit_grace_days`,
// `instalment_default_after_days`, `instalment_default_after_missed`) were read by
// the credit and instalment modules out of settings that could not supply them.
//
// This file is the rule that stops it recurring. It reads the three lists —
// **the columns** (from the migration SQL), **the whitelist** (`DEFAULT_SETTINGS`)
// and **the controls** (from the screen source) — and refuses to let them drift.
//
// It is a source-level test on purpose: the defect is a disagreement between two
// files, and the only place both are visible at once is here.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Comments blanked out, newlines kept.
 *
 * The scan below looks for `settings.<key>` and a comment that explains WHY a key
 * was removed — "the dead guard read `settings.staff_void_requires_manager`" —
 * is not a read of it. Blanking the comment instead of deleting it keeps every
 * line number in the failure message pointing at the line it names.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next || ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (ch === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
      if (i < src.length) { out += '  '; i += 2; }
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}
const { DEFAULT_SETTINGS, FLAG_SETTINGS, PLAN_FIELDS } = require(path.join(ROOT, 'domain/planLimits'));

/**
 * Numbers whose sensible default is 0 or 1, and which are therefore NOT flags even
 * though the write path once thought they were. Named here so that a new one has to
 * be added deliberately rather than discovered by an owner whose saved value came
 * back as zero.
 */
const NUMBERS_THAT_DEFAULT_TO_ZERO_OR_ONE = Object.freeze({
  credit_grace_days: 'a count of days; the left edge of the range is zero',
  staff_credit_max: 'a naira cap; zero means the cashier may not extend credit at all',
});

/** The columns of `client_settings`, straight out of the SQL that creates it. */
function clientSettingsColumns() {
  const dir = path.join(ROOT, 'schema', 'migrations');
  const cols = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const table = sql.match(/CREATE TABLE(?: IF NOT EXISTS)?[\s]+client_settings[\s\S]*?\n\);/);
    if (table) {
      for (const line of table[0].split('\n')) {
        const m = line.trim().match(/^([a-z_][a-z_0-9]*)\s+(TEXT|INTEGER|REAL|NUMERIC)\b/i);
        if (m) cols.add(m[1]);
      }
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+client_settings\s+ADD COLUMN\s+([a-z_][a-z_0-9]*)/gi)) {
      cols.add(m[1]);
    }
  }
  return cols;
}

/** `SETTING_GROUPS` from the screen, read as data rather than imported — it lives
 *  inside a browser IIFE and cannot be required. */
function settingGroups() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/views/admin.js'), 'utf8');
  const start = src.indexOf('const SETTING_GROUPS');
  assert.ok(start > 0, 'SETTING_GROUPS is no longer in public/js/views/admin.js — this test reads the screen that renders it');
  const end = src.indexOf('\n  ];', start);
  const block = src.slice(start, end);
  const groups = [];
  let current = null;
  for (const line of block.split('\n')) {
    const title = line.match(/title:\s*'([^']+)'/);
    if (title && !/key:/.test(line)) { current = { title: title[1], items: [] }; groups.push(current); continue; }
    if (!current) continue;
    const key = line.match(/\{ key: '([a-z_0-9]+)'/);
    if (key) {
      const type = (line.match(/type:\s*'([a-z]+)'/) || [])[1] || 'text';
      const min = line.match(/min:\s*(-?[\d.]+)/);
      const max = line.match(/max:\s*(-?[\d.]+)/);
      current.items.push({ key: key[1], type, min: min ? Number(min[1]) : null, max: max ? Number(max[1]) : null });
      continue;
    }
    if (/type:\s*'fact'/.test(line)) current.items.push({ fact: true });
  }
  return groups;
}

/**
 * Columns the database or the platform maintains, which must never be settable
 * through the settings API. They are named here so that "no control" and "no
 * column entry" are statements rather than omissions — a mass-assignment of a
 * request body must not be able to backdate `data_reset_at` or forge `updated_by`.
 */
const SYSTEM_MAINTAINED = Object.freeze({
  data_reset_at: 'written by the data-reset flow, and an owner backdating it would rewrite when the client last wiped their books',
  updated_at: 'set by the writer of every update',
  updated_by: 'set from the signed-in user, never from the body',
});

/** Settings the screen must NOT offer, with the reason it must not. Each one is a
 *  deliberate exclusion, so an accidental omission cannot hide in this list. */
const NOT_A_CONTROL = Object.freeze({
  id: 'the table has exactly one row',
  logo_data_url: 'a data URL is uploaded through the branding screen, not typed into a text field',
  // THE FIVE BRANDING FIELDS ARE ON THE SCREEN — in the branding card at the top of it, which
  // writes them through `PUT /api/branding` so the change is recorded as `BRANDING_UPDATED`
  // in the same act as the logo. They are excluded from THIS list because a second writable
  // control for one fact, on one screen, lets the later save silently undo the earlier one.
  // `test/audit/audit.branding.js` refuses to let them reappear here.
  business_name: 'offered by the branding card on the same screen, which writes it through PUT /api/branding and records BRANDING_UPDATED',
  receipt_footer_text: 'offered by the branding card on the same screen, which writes it through PUT /api/branding and records BRANDING_UPDATED',
  admin_contact_name: 'offered by the branding card on the same screen, which writes it through PUT /api/branding and records BRANDING_UPDATED',
  admin_contact_phone: 'offered by the branding card on the same screen, which writes it through PUT /api/branding and records BRANDING_UPDATED',
  admin_contact_email: 'offered by the branding card on the same screen, which writes it through PUT /api/branding and records BRANDING_UPDATED',
  primary_business_id: 'decided by provisioning and by the business switcher, never by hand',
  max_businesses: 'commercial: the plan decides it, the server enforces it on creation, and only the platform administrator may write it (403 PLATFORM_ADMIN_REQUIRED)',
  max_branches: 'commercial: the plan decides it, the server enforces it on creation, and only the platform administrator may write it (403 PLATFORM_ADMIN_REQUIRED)',
  max_staff: 'commercial: the plan decides it, the server enforces it on creation, and only the platform administrator may write it (403 PLATFORM_ADMIN_REQUIRED)',
  subscription_status: 'commercial: the platform administrator sets it; a client that could reset its own status after a suspension would not have one',
  subscription_plan: 'commercial: the platform administrator names it, and the name is printed in every cap refusal the client sees',
  subscription_renewal_date: 'commercial: the platform administrator sets it; it is what the subscription gate quotes back at a suspended client',
});

test('settings: every control is backed by a real column, and every column is reachable', async (t) => {
  const columns = clientSettingsColumns();
  const groups = settingGroups();
  const controls = groups.flatMap((g) => g.items.filter((i) => i.key));
  const facts = groups.flatMap((g) => g.items.filter((i) => i.fact));

  await t.test('the screen has controls and says some things outright', () => {
    // THE BRANDING CARD COUNTS TOO. The floor exists to notice a screen that has been emptied
    // out, and five of the settings it carries — the trading name, the receipt footer and the
    // three contact details — are now typed into the branding card rather than into a switch
    // group, because the card writes them alongside the logo. Counting only `SETTING_GROUPS`
    // would read that move as a deletion.
    const viewSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'admin.js'), 'utf8');
    const branding = ((viewSrc.match(/const BRANDING_FIELDS = \[([^\]]*)\]/) || [])[1] || '')
      .split(',').filter((x) => x.trim()).length;
    assert.ok(branding >= 5, `the branding card declares ${branding} field(s) — it should declare the five the route accepts`);
    assert.ok(controls.length + branding >= 40,
      `only ${controls.length} switch(es) and ${branding} branding field(s) on the Settings screen`);
    assert.ok(facts.length >= 5,
      `only ${facts.length} stated facts — the controls that used to promise a choice the system does not offer should say what it does instead`);
  });

  await t.test('every control writes a column, through a whitelist that contains it', () => {
    const orphans = controls.filter((c) => !(c.key in DEFAULT_SETTINGS));
    assert.deepEqual(orphans.map((c) => c.key), [],
      'these controls name a key the settings route will refuse to write, so they can never save (and, if the key is not a column either, they will not even draw)');
    const notColumns = controls.filter((c) => !columns.has(c.key));
    assert.deepEqual(notColumns.map((c) => c.key), [],
      'these controls are in DEFAULT_SETTINGS but have no column in client_settings');
  });

  await t.test('no two controls claim the same setting', () => {
    const seen = new Map();
    for (const c of controls) {
      if (seen.has(c.key)) assert.fail(`${c.key} is rendered twice (${seen.get(c.key)} and again) — two inputs for one value save whichever the reader finds last`);
      seen.set(c.key, true);
    }
  });

  await t.test('a writable setting is either on the screen or excluded on purpose', () => {
    const shown = new Set(controls.map((c) => c.key));
    const unreachable = Object.keys(DEFAULT_SETTINGS)
      .filter((k) => !shown.has(k) && !(k in NOT_A_CONTROL));
    assert.deepEqual(unreachable, [],
      'these settings can be written through the API and cannot be reached from the screen — the columns exist and the merchant cannot change them');
    // And the exclusions must be real settings, so a rename cannot silently
    // leave a reason behind for a key nobody has.
    const stale = Object.keys(NOT_A_CONTROL).filter((k) => !(k in DEFAULT_SETTINGS));
    assert.deepEqual(stale, [], 'these exclusions name settings that no longer exist');
  });

  await t.test('the commercial settings are exactly the ones the platform administrator alone may write', () => {
    // The screen's exclusion list and the route's authority list are two statements of
    // one rule, and they are written in two different files. If a key is added to one
    // and not the other, the screen offers a control the API will refuse, or the API
    // lets a client change something the screen was hiding on purpose.
    const commercial = Object.keys(NOT_A_CONTROL)
      .filter((k) => (k in DEFAULT_SETTINGS) && /^(max_(businesses|branches|staff)|subscription_(status|plan|renewal_date))$/.test(k))
      .sort();
    assert.deepEqual([...PLAN_FIELDS].sort(), commercial,
      'the keys the settings route reserves for the platform administrator and the keys the screen refuses to draw have drifted apart');
  });

  await t.test('every column the API can write is in the whitelist', () => {
    // The other direction of the same disagreement: a column with no entry in
    // DEFAULT_SETTINGS is a column the settings route refuses, which is how
    // `receipt_footer_text` — the line printed on every customer's receipt — ended
    // up settable only from the branding screen.
    const missing = [...columns].filter((c) => !(c in DEFAULT_SETTINGS) && !(c in SYSTEM_MAINTAINED));
    assert.deepEqual(missing, [],
      'these client_settings columns cannot be written through the settings API. Add them to DEFAULT_SETTINGS, or list them in SYSTEM_MAINTAINED with the reason they must not be settable');
    for (const key of Object.keys(SYSTEM_MAINTAINED)) {
      assert.ok(columns.has(key), `${key} is listed as system-maintained and is not a column at all`);
      assert.ok(!(key in DEFAULT_SETTINGS), `${key} is system-maintained and is in the settings whitelist, so it could be written from a request body`);
    }
  });

  await t.test('a number control\'s range agrees with its default', () => {
    const bad = [];
    for (const c of controls.filter((x) => x.type === 'number')) {
      const def = DEFAULT_SETTINGS[c.key];
      if (typeof def !== 'number') continue;
      if (c.min !== null && def < c.min) bad.push(`${c.key}: default ${def} is below the minimum ${c.min}`);
      if (c.max !== null && def > c.max) bad.push(`${c.key}: default ${def} is above the maximum ${c.max}`);
      if (c.min !== null && c.max !== null && c.min > c.max) bad.push(`${c.key}: minimum ${c.min} is above maximum ${c.max}`);
    }
    assert.deepEqual(bad, [], 'a control whose own default is outside its own range is a control that cannot be saved unchanged');
  });

  await t.test('no route reads a settings key that does not exist', () => {
    // A GUARD THAT CAN NEVER FIRE READS AS ENFORCEMENT.
    //
    // `server/routes/sales.js` refused a void when
    // `Number(settings.staff_void_requires_manager)` was truthy. `Number(undefined)`
    // is NaN, so the refusal was unreachable — while the code read as though voids
    // were policed. This walks every `settings.x` in the server and the domain and
    // insists the key is one a client could actually have set.
    const known = new Set([...Object.keys(DEFAULT_SETTINGS), ...columns]);
    const noise = new Set(['enabled', 'length', 'name', 'value', 'column', 'field', 'from', 'to',
      'then', 'catch', 'map', 'filter', 'find', 'all', 'first', 'scalar', 'run', 'has', 'size',
      'rows', 'rate', 'keys', 'now', 'row', 'data', 'object', 'string', 'number', 'boolean',
      'instalment', 'days']);
    const offenders = [];
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.data', 'dist', 'build', 'coverage'].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
      }
      return out;
    };
    for (const dir of ['server', 'domain', 'worker', 'tools']) {
      for (const file of walk(path.join(ROOT, dir))) {
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        for (const m of src.matchAll(/\bsettings\s*\.\s*([a-z_][a-z_0-9]{3,})/g)) {
          const key = m[1];
          if (known.has(key) || noise.has(key)) continue;
          offenders.push(`${path.relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length} reads settings.${key}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'these read a settings key that is neither a column nor a default, so the expression is always undefined and whatever the code decided after `||` always wins');
  });

  await t.test('a flag is a flag and a number is a number, and nothing guesses', () => {
    // THE DEFECT THIS EXISTS FOR: the settings route decided "this is a boolean" by
    // looking at the default — `[0, 1].includes(def)` — so `credit_grace_days: 30`
    // went to `boolField`, which did not recognise 30 as a boolean, returned its
    // fallback, and saved ZERO with a success message. FLAG_SETTINGS names them.
    const numeric = Object.keys(DEFAULT_SETTINGS).filter((k) => typeof DEFAULT_SETTINGS[k] === 'number' && k !== 'id');
    const flagish = numeric.filter((k) => [0, 1].includes(DEFAULT_SETTINGS[k]));
    const wrong = flagish.filter((k) => !FLAG_SETTINGS.has(k) && !(k in NUMBERS_THAT_DEFAULT_TO_ZERO_OR_ONE));
    assert.deepEqual(wrong, [],
      'these settings default to 0 or 1 and are neither flags nor listed as numbers that do so — decide which they are, because the write path can no longer tell them apart by looking');

    for (const key of FLAG_SETTINGS) {
      assert.ok(key in DEFAULT_SETTINGS, `FLAG_SETTINGS names ${key}, which is not a setting`);
      assert.ok([0, 1].includes(DEFAULT_SETTINGS[key]), `${key} is listed as a flag and its default is ${DEFAULT_SETTINGS[key]}`);
      assert.ok(controls.some((c) => c.key === key), `${key} is a flag with no control on the Settings screen`);
    }
    for (const key of Object.keys(NUMBERS_THAT_DEFAULT_TO_ZERO_OR_ONE)) {
      assert.ok(key in DEFAULT_SETTINGS, `${key} is documented as a zero-default number and is not a setting`);
      assert.ok(!FLAG_SETTINGS.has(key), `${key} cannot be both a flag and a number`);
      assert.ok(controls.some((c) => c.key === key), `${key} is a number with no control on the Settings screen`);
    }
  });

  await t.test('the settings the credit and instalment modules read are setable', () => {
    // Named individually, because this is the defect that was actually found: three
    // policy numbers that the domain reads, the screen never asked for, and no
    // migration had ever created. `test/integration/settings.test.js` proves the
    // round trip; this proves the key is reachable at all.
    for (const key of ['credit_grace_days', 'instalment_default_after_days', 'instalment_default_after_missed']) {
      assert.ok(columns.has(key), `${key} is read by the domain and is not a column in client_settings`);
      assert.ok(key in DEFAULT_SETTINGS, `${key} is a column and is not in the settings whitelist`);
      assert.ok(controls.some((c) => c.key === key), `${key} is a writable policy number with no control on the Settings screen`);
    }
  });
});

test('serial numbers are off unless the business turns them on', () => {
  assert.equal(DEFAULT_SETTINGS.serial_tracking_enabled, 0,
    'the default demands serial numbers from a shop that has not asked for them');
  assert.ok(FLAG_SETTINGS.has('serial_tracking_enabled'), 'the serial switch must stay a flag, not a number');
});
