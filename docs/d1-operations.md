# D1 operations

How to read, migrate and back up the production database without breaking it.

## Why D1 needs its own document

D1 is SQLite with a different execution model, and three differences change how
you write code against it:

1. **No interactive transactions.** `db.transaction(async (tx) => …)` does not
   hold a transaction open across `await` points the way `better-sqlite3` does.
   The adapter queues statements in `tx.queue(sql, params)` and executes them as
   a **batch** when the callback returns. Consequence: **never branch on the
   result of a write inside a transaction.** The result does not exist yet. Read
   everything you need first, decide, then queue.
2. **A batch is atomic, but a queued statement cannot be inspected mid-flight.**
   `worker/src/d1.js` annotates a batch failure with the index of the statement
   that failed, because D1's own error names no statement.
3. **Limits are real.** A single statement's bound parameters, the total query
   size, and the number of statements in a batch are all capped. This codebase
   stays well inside them — the largest batch is a stocktake commit — but a
   future feature that writes ten thousand rows in one transaction will not.

## The database

| | |
|---|---|
| Name | `stockridge` |
| Shape | 76 tables, 22 views, 2 migrations |
| Migration table | `d1_migrations` (the Node backend uses `_migrations`; `appliedMigrationCount()` reads whichever exists, and counting the wrong one reports a healthy deployment as unmigrated) |
| Local file | `.data/stockridge.db` (Node only, gitignored) |

## Everyday commands

All of these need **Node 22** and `CLOUDFLARE_API_TOKEN` in the environment.

```bash
export CLOUDFLARE_API_TOKEN=...            # or: set -a; . ./.env.deploy; set +a
CFG="--config worker/wrangler.toml"

# What is in there?
npx wrangler d1 execute stockridge --remote $CFG \
  --command "SELECT COUNT(*) FROM businesses WHERE is_deleted = 0"

# A table's shape
npx wrangler d1 execute stockridge --remote $CFG \
  --command "SELECT sql FROM sqlite_master WHERE name = 'stock_batches'"

# Machine-readable, for a script
npx wrangler d1 execute stockridge --remote $CFG --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# Which migrations have been applied
npx wrangler d1 execute stockridge --remote $CFG \
  --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
```

Add `--json` and pipe through `python3 -c "import sys,json; ..."` when you need to
read the result in a script; the human-readable output is a box-drawing table that
is pleasant to read and awkward to parse.

## Migrations

The same `.sql` files serve both backends. Applied files are **checksummed**, and
`migrate()` hard-errors if an applied file has been edited — so a migration is
immutable once it has run anywhere.

```bash
# Apply to the deployed database
npx wrangler d1 migrations apply stockridge --remote --config worker/wrangler.toml

# Apply to a local D1 (for testing the D1 path without touching production)
npx wrangler d1 migrations apply stockridge --local --config worker/wrangler.toml

# See what would be applied, without applying it
npx wrangler d1 migrations list stockridge --remote --config worker/wrangler.toml
```

### Adding a migration

1. New file in `schema/migrations/`, numbered next in sequence: `0003_*.sql`.
2. **Additive only, for one release.** `ALTER TABLE … ADD COLUMN` is safe on both
   runtimes. A rename or a drop breaks any Worker version still running the old
   code, and a rollback then becomes impossible.
3. Write it so it can run twice: `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE` guarded by a check.
4. Run `npm run verify`. `tools/sql-audit.js` reads every statement in the repo,
   including new SQL, for placeholder/value mismatches.
5. Apply it to a **copy** first. On Node:
   `cp .data/stockridge.db /tmp/try.db && node tools/migrate.js --db /tmp/try.db`.

Never edit an applied migration. If it was wrong, write the next one.

## Backups

Two kinds, and you want both.

```bash
# 1. Schema AND data, as SQL — the human-readable belt
npx wrangler d1 export stockridge --remote --config worker/wrangler.toml \
  --output=backup-$(date +%F).sql

# 2. Data only — smaller, and the form you would actually restore from
npx wrangler d1 export stockridge --remote --config worker/wrangler.toml \
  --no-schema --output=data-$(date +%F).sql
```

`.data/legacy-d1-20261004-full.sql` in this repository is a real example: it is
the export taken before an earlier generation of the database was deleted. It is
gitignored, and that is deliberate — an export contains every sale, every staff
record and every PIN hash of an entire business. **Never commit one.**

D1 also keeps its own point-in-time recovery window, which is the fastest path to
"the wrong row was deleted five minutes ago". Check the current window in the
Cloudflare dashboard for your plan; it is not unlimited, and it is not a
substitute for an export you hold.

### Restoring

```bash
npx wrangler d1 execute stockridge --remote --config worker/wrangler.toml \
  --file=backup-2026-10-05.sql
```

A full export starts with `CREATE TABLE`, so restoring into a database that
already has the schema fails at the first statement with
`table businesses already exists`. Either restore into an empty database, or take
the `--no-schema` export and delete the affected rows first. This is exactly what
happened during the deployment that produced `legacy-d1-20261004-full.sql` — the
error is at the *first* table, not at a suspicious-looking row, so read the first
line of the error rather than the last.

## Reading the data safely

- **Every table is soft-deleted.** A row with `is_deleted = 1` is not gone, and a
  query without `WHERE is_deleted = 0` will include deleted businesses, sold
  stock and retired staff. Almost every route in `server/routes/` filters on it;
  a hand-written query must too.
- **Money is in kobo.** `190000000` is ₦1,900,000. Divide by 100 only at the edge.
- **Timestamps are UTC.** "Today" for a Nigerian shop is West Africa Time
  (UTC+1), so a sale at 00:30 WAT belongs to a different UTC day. Use
  `domain/time.js` (`watDayRangeUtc`, `watToUtc`) rather than comparing UTC
  strings to a date someone typed.
- **Scope is `branch_id`.** A business with three branches has three branches'
  worth of rows in the same tables, and `branch_id` is the only thing separating
  them.

Two queries worth keeping to hand:

```sql
-- Which branches exist, for a given business, and how busy each is
SELECT b.id, b.name, b.city,
       (SELECT COUNT(*) FROM sales s WHERE s.branch_id = b.id AND s.is_deleted = 0) AS sales
  FROM branches b WHERE b.business_id = ? AND b.is_deleted = 0 ORDER BY b.name;

-- Anything that looks like it should not be there
SELECT (SELECT COUNT(*) FROM businesses WHERE is_deleted = 0) AS businesses,
       (SELECT COUNT(*) FROM users      WHERE role = 'ADMIN' AND is_deleted = 0) AS admins,
       (SELECT COUNT(*) FROM d1_migrations) AS migrations;
```

## The readiness endpoints

| Endpoint | Answers | Codes |
|---|---|---|
| `GET /api/health` | Is the process alive? No database access at all, so it cannot fail for a database reason. | always 200 |
| `GET /api/health/ready` | Can it serve a shop? Schema, migrations, an active business. | 200 `ready`; 503 `awaiting_first_business`; 503 `not_ready` |
| `GET /api/diagnose` | Is the **deployment** wired correctly? Database reachable, ≥50 tables, migrations recorded, an administrator exists, **PIN hashing round-trips in this runtime**, and the administrator's sign-in lookup works and its stored hash is well-formed. | 200 / 503 |

`awaiting_first_business` is not a fault: a deployment is handed over with one
administrator and no business, on purpose. `not_ready` is a fault.

The PIN round-trip check is not decoration. It found a defect that no test could:
the Workers WebCrypto implementation refuses PBKDF2 iteration counts above
100,000, which silently made every sign-in fail while the schema, the
administrator row and the hash format all looked correct. Keep it.
