'use strict';
// =====================================================================
// test/integration/lib/purge-fixture.js — ONE ROW IN EVERY TABLE
// =====================================================================
// Kept out of the test file it serves so that a DIAGNOSIS can reuse it. When a
// cleanup step fails, the question "what still points at that row?" is answered by
// reproducing the exact fixture — and a diagnosis that approximates the fixture
// answers a different question. Loading a test file would run its tests; loading
// this loads only the fixture.
//
// The fixture reads the SCHEMA rather than a hand-written list of tables, so a
// table added by a future migration is seeded automatically — and if a purge plan
// forgets it, the counts in the test fail.
// =====================================================================

const path = require('path');

/** The CREATE TABLE text for every table, plus the CHECK-allowed values for each column. */
function schemaMap(db) {
  const rows = db.raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const map = {};
  for (const { name, sql } of rows) {
    const checks = {};
    const re = /CHECK\s*\(\s*([a-z_]+)\s+IN\s*\(([^)]*)\)\s*\)/gi;
    let m;
    while ((m = re.exec(sql))) {
      const values = m[2].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter((v) => v && !/^-?\d+$/.test(v));
      if (values.length) checks[m[1]] = values[0];
    }
    map[name] = { sql, checks };
  }
  return map;
}

const ID_LIKE = /_id$/;
const DATE_LIKE = /(_at|_date|_on)$/;

/**
 * Seed one row in every table, parents first.
 *
 * Returns the ids it created per table, so assertions can look a row up afterwards
 * rather than counting on a table being empty.
 */
async function seedEverything(db, { businessId, branchId, secondBranchId }) {
  const map = schemaMap(db);
  const tables = Object.keys(map);
  const created = {};
  const failures = [];

  // Foreign keys first: repeat the pass until no more progress is possible, which
  // is a topological sort expressed as a loop.
  let pending = tables.slice();
  for (let pass = 0; pass < tables.length && pending.length; pass += 1) {
    const still = [];
    for (const table of pending) {
      const fks = db.raw.prepare(`PRAGMA foreign_key_list(${table})`).all();
      const needs = fks.map((fk) => fk.table).filter((t) => t !== table && map[t]);
      if (needs.some((t) => !created[t])) { still.push(table); continue; }
      let provided = {};
      try {
        const cols = db.raw.prepare(`PRAGMA table_info(${table})`).all();
        for (const col of cols) {
          const name = col.name;
          if (col.pk && col.dflt_value != null) continue;            // id is generated
          // DERIVED FIRST: a column a CHECK constrains may be NULLABLE and still
          // have to hold a value, because a CHECK that compares two columns is
          // unknown — and therefore failed — when either is NULL.
          const derived = derivedValue(table, name, { secondBranchId, branchId });
          if (derived !== undefined) { provided[name] = derived; continue; }
          // THE BUSINESS AND THE BRANCH, EVEN WHEN THE COLUMN IS NULLABLE.
          // Leaving them NULL was the fixture's second real bug, and it hid three
          // genuine questions at once: a product with no business is invisible to a
          // business-scoped purge, so "the mode did not remove it" and "the mode did
          // not keep it" both looked like purge defects when the row was simply
          // unattached. A fixture must look like a shop's database, where every
          // trading row belongs to a shop.
          if (name === 'business_id' && businessId) { provided[name] = businessId; continue; }
          if (name === 'branch_id' && branchId) { provided[name] = branchId; continue; }
          if (col.dflt_value != null && !col.notnull) continue;       // nullable with a default: leave it
          if (!col.notnull) continue;                                 // nullable: leave it alone
          const fk = fks.find((f) => f.from === name);
          if (fk && created[fk.table]) { provided[name] = created[fk.table]; continue; }
          if (map[table].checks[name]) { provided[name] = map[table].checks[name]; continue; }
          if (name === 'mode') { provided[name] = 'PERIOD'; continue; }
          if (DATE_LIKE.test(name)) { provided[name] = new Date().toISOString().slice(0, 19).replace('T', ' '); continue; }
          if (/INTEGER|REAL|NUMERIC/i.test(col.type)) { provided[name] = 1; continue; }
          provided[name] = name === 'username' ? `seed-${table}`.slice(0, 30) : 'x';
        }
        const names = Object.keys(provided);
        const sql = `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
        const res = db.raw.prepare(sql).run(...names.map((n) => provided[n]));
        created[table] = provided.id || String(res.lastInsertRowid || 'row-1');
        // READ BACK THE GENERATED ID BY `rowid` — NOT WITH `LIMIT 1`.
        //
        // This line said `SELECT id FROM ${table} LIMIT 1`, which returns THE FIRST
        // ROW IN THE TABLE. While seeding the FIRST business that is the row just
        // inserted, so everything looked right; while seeding the SECOND business it
        // returned the FIRST business's id, so every child row of shop B was attached
        // to shop A's parents. Cleaning up shop A then failed on foreign keys owned by
        // shop B — one line, and it made four cleanup steps look broken for an
        // afternoon. `rowid` is the row this statement actually wrote.
        //
        // (Only where the table HAS an `id` column: three tables in this schema are
        // keyed on a composite instead — idempotency_keys, user_sessions,
        // branch_sync_status — and asking them for `id` was the fixture's FIRST bug.)
        const hasId = cols.some((c) => c.name === 'id');
        if (hasId && res.lastInsertRowid != null) {
          const back = db.raw.prepare(`SELECT id FROM ${table} WHERE rowid = ?`).get(res.lastInsertRowid);
          if (back && back.id != null) created[table] = String(back.id);
        }
      } catch (err) {
        // SOME TABLES ARE DEPLOYMENT-WIDE, NOT PER BUSINESS — the VAT and WHT rates,
        // the settings, a product's measure axis. Seeding a second business cannot
        // create a second row in those, and a UNIQUE collision is the schema saying
        // so. The row already exists, which is all this fixture needs.
        // A DEPLOYMENT-WIDE ROW CAN COLLIDE ON A UNIQUE COLUMN **OR** ON A CHECK: the
        // settings table is `CHECK (id = 1)`, so a second business cannot have its own
        // settings row and the schema says so. Either way the row already exists, which
        // is all this fixture needs.
        const isUniqueCollision = /UNIQUE constraint failed/i.test(err.message);
        // A CHECK COLLISION IS A SINGLETON, NOT SOMETHING TO WORK AROUND. `client_settings`
        // is `CHECK (id = 1)`: there is one row per deployment BY DESIGN, and its id cannot
        // be renamed, so the only correct answer is to use the row that exists. (Renaming
        // works for a UNIQUE text column — a username — and does not work for a fixed value.)
        const isSingleton = !isUniqueCollision && /CHECK constraint failed/i.test(err.message)
          && db.raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c > 0;
        if (isSingleton) {
          const cols0 = db.raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          const row0 = cols0.includes('id') ? db.raw.prepare(`SELECT id FROM ${table} LIMIT 1`).get() : null;
          created[table] = row0 && row0.id != null ? String(row0.id) : 'row-1';
          continue;
        }
        if (isUniqueCollision) {
          const tableCols = db.raw.prepare(`PRAGMA table_info(${table})`).all();
          const hasId = tableCols.some((c) => c.name === 'id');
          const hasBiz = tableCols.some((c) => c.name === 'business_id');
          // DEPLOYMENT-WIDE MEANS NO BUSINESS **AND NO PARENTS**: the settings, the WHT
          // rate table. A second business cannot have a second row and pointing at the
          // one that exists is what the app itself does.
          //
          // A table with no business_id but WITH a parent is not deployment-wide — it
          // is a child, scoped through that parent. Treating sale lines as shared gave
          // business B's lines a foreign key to business A's sale, which is a fixture
          // inventing a defect and then reporting it against the purge.
          const fks = db.raw.prepare(`PRAGMA foreign_key_list(${table})`).all().filter((fk) => fk.table !== table);
          if (!hasBiz && !fks.length) {
            const shared = hasId ? db.raw.prepare(`SELECT id FROM ${table} LIMIT 1`).get() : null;
            created[table] = shared && shared.id != null ? String(shared.id) : null;
            continue;
          }
          // THIS BUSINESS'S OWN ROW, IF IT HAS ONE ALREADY.
          const mine = hasId && hasBiz ? db.raw.prepare(`SELECT id FROM ${table} WHERE business_id = ? LIMIT 1`).get(businessId) : null;
          if (mine && mine.id != null) { created[table] = String(mine.id); continue; }
          // IT DOES NOT — SO MAKE ONE. Reusing the OTHER business's row was this
          // fixture's third bug, and the nastiest: the second business's child rows
          // then pointed at the first business's parent rows, so cleaning up one shop
          // failed on foreign keys owned by the other. The collision is on a UNIQUE
          // text column (a username, a rate code), so the retry suffixes the text
          // values and leaves every foreign key alone.
          let attemptErr = null;
          for (let attempt = 2; attempt <= 4 && !attemptErr; attempt += 1) {
            const second = {};
            // NEVER SUFFIX A CHECK-CONSTRAINED COLUMN. `role = 'ADMIN'` became
            // `role = 'ADMIN-b2'` and the retry died on the enum, which then read as
            // "this table cannot be seeded" when the real problem was this line.
            const enums = (map[table] && map[table].checks) || {};
            for (const [k, v] of Object.entries(provided)) {
              const freeText = typeof v === 'string' && !/_id$/.test(k) && !enums[k]
                && v !== businessId && v !== branchId && v !== secondBranchId;
              second[k] = freeText ? `${v}-b${attempt}` : v;
            }
            const names2 = Object.keys(second);
            try {
              const res2 = db.raw.prepare(`INSERT INTO ${table} (${names2.join(', ')}) VALUES (${names2.map(() => '?').join(', ')})`).run(...names2.map((n) => second[n]));
              if (hasId && res2.lastInsertRowid != null) {
                const back2 = db.raw.prepare(`SELECT id FROM ${table} WHERE rowid = ?`).get(res2.lastInsertRowid);
                if (back2 && back2.id != null) created[table] = String(back2.id);
              }
              attemptErr = null;
              break;
            } catch (e2) { attemptErr = e2; }
          }
          const row = hasId && hasBiz ? db.raw.prepare(`SELECT id FROM ${table} WHERE business_id = ? LIMIT 1`).get(businessId) : (hasId ? db.raw.prepare(`SELECT id FROM ${table} LIMIT 1`).get() : null);
          if (created[table]) continue;
          if (attemptErr || (row && row.id == null && hasId)) {
            // NO INVENTED IDS. A made-up row reference is a fixture lying to the test:
            // the children then fail with a foreign key that has nothing to do with the
            // code under test. Report it instead.
            failures.push(`${table}: ${attemptErr ? attemptErr.message : 'own row not found after insert'}`);
            created[table] = null;
            continue;
          }
          created[table] = row && row.id != null ? String(row.id) : null;
          continue;
        }
        failures.push(`${table}: ${err.message}`);
        created[table] = created[table] || null;
      }
    }
    if (still.length === pending.length) { pending = []; break; } // no progress; stop
    pending = still;
  }
  return { created, failures, seeded: Object.values(created).filter(Boolean).length };
}

/**
 * How many rows each named table holds for a business.
 *
 * Child tables have no `business_id` of their own — `sale_items` hangs off a sale
 * — so they are counted through their parent, the same way the purge scopes them.
 * Counting them "all rows" would be meaningless the moment two businesses trade in
 * one database, which is precisely the test below that matters most.
 */
const VIA_PARENT = Object.freeze({
  sale_items: ['sales', 'sale_id'],
  sale_payments: ['sales', 'sale_id'],
  sale_serials: ['sales', 'sale_id'],
  sale_return_items: ['sale_returns', 'sale_return_id'],
  purchase_order_items: ['purchase_orders', 'purchase_order_id'],
  gl_journal_lines: ['gl_journal_entries', 'journal_entry_id'],
});

function counts(db, tables, column = 'business_id', id = null) {
  const out = {};
  for (const t of tables) {
    try {
      const hasBiz = db.raw.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === column);
      if (id && hasBiz) { out[t] = db.raw.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${column} = ?`).get(id).c; continue; }
      if (id && VIA_PARENT[t]) {
        const [parent, fk] = VIA_PARENT[t];
        out[t] = db.raw.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${fk} IN (SELECT id FROM ${parent} WHERE business_id = ?)`).get(id).c;
        continue;
      }
      out[t] = db.raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    } catch (err) { out[t] = null; }
  }
  return out;
}

/** A business + branch + admin, created the way the schema expects. */
async function businessFixture(db, name) {
  const b = db.raw.prepare("INSERT INTO businesses (id, name, is_active, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, 1, 0, datetime('now'), datetime('now'))").run(name);
  void b;
  const businessId = String(db.raw.prepare('SELECT id FROM businesses WHERE name = ?').get(name).id);
  db.raw.prepare("INSERT INTO branches (id, business_id, name, code, is_active, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, ?, ?, 1, 0, datetime('now'), datetime('now'))")
    .run(businessId, `${name} Main`, `BR-${name.slice(0, 4)}`.toUpperCase());
  const branchId = String(db.raw.prepare('SELECT id FROM branches WHERE business_id = ?').get(businessId).id);
  // A SECOND branch, because the schema refuses a transfer from a branch to
  // itself: `CHECK (from_branch_id <> to_branch_id)`. A fixture that could not
  // create the row would silently skip a table the purge plan names.
  db.raw.prepare("INSERT INTO branches (id, business_id, name, code, is_active, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, ?, ?, 1, 0, datetime('now'), datetime('now'))")
    .run(businessId, `${name} Depot`, `DP-${name.slice(0, 4)}`.toUpperCase());
  const secondBranchId = String(db.raw.prepare("SELECT id FROM branches WHERE business_id = ? AND id <> ?").get(businessId, branchId).id);
  return { businessId, branchId, secondBranchId };
}

/**
 * Columns whose NOT NULL value cannot be a placeholder, because an arithmetic
 * CHECK relates them to each other. Each one is a rule the schema genuinely
 * enforces, discovered by running this fixture — which is the point of building
 * the fixture from the schema rather than from a list somebody typed.
 */
function derivedValue(table, column, ctx) {
  const RULES = {
    sales: { total: 1, amount_paid: 1, balance_due: 0, subtotal: 1, vat_amount: 0 },
    deposits: { total_price: 1, deposit_amount: 1, balance_due: 0 },
    instalment_plans: { principal: 1, interest_amount: 0, total_payable: 1 },
    wht_entries: { gross_amount: 1, net_amount: 1, wht_amount: 0 },
    gl_journal_lines: { debit: 1, credit: 0 },
    // BOTH columns, not just the "to". The schema says
    // `CHECK (from_branch_id <> to_branch_id)`, and SQLite treats NULL as
    // unknown — so a nullable from_branch_id left unset fails the check just as
    // surely as setting the two equal. This fixture found that by running.
    stock_transfers: { from_branch_id: ctx.branchId, to_branch_id: ctx.secondBranchId },
  };
  return RULES[table] && Object.prototype.hasOwnProperty.call(RULES[table], column) ? RULES[table][column] : undefined;
}


module.exports = { seedEverything, businessFixture, counts, schemaMap, derivedValue, VIA_PARENT };
