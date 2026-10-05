'use strict';
// =====================================================================
// tools/migrate.js — APPLY THE SCHEMA
// =====================================================================
// `npm run db:migrate`. Idempotent: an applied migration is recorded with a
// checksum in `_migrations`, and re-running is a no-op. If a file that was
// already applied has since CHANGED, migrate() refuses rather than silently
// leaving the database on the old definition — a schema that quietly differs
// from the code is the kind of bug that surfaces as "works on my machine".
//
//   node tools/migrate.js                 apply pending migrations
//   node tools/migrate.js --status        show what is applied
//   node tools/migrate.js --reset         delete the database and re-apply
//   node tools/migrate.js --db=/path.db   target a specific file
// =====================================================================

const path = require('node:path');
const fs = require('node:fs');
const { openDatabase, migrate, schemaInfo, MIGRATIONS_DIR } = require('../server/lib/db');

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='));
  const file = (dbArg && dbArg.split('=')[1]) || process.env.STOCKRIDGE_DB
    || path.join(__dirname, '..', '.data', 'stockridge.db');
  const reset = args.includes('--reset');
  const status = args.includes('--status');

  if (reset) {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) { fs.rmSync(f); console.log(`removed ${path.relative(process.cwd(), f)}`); }
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openDatabase({ file });

  if (status) {
    // `_migrations` keys on `id`, not `name`.
    const applied = await db.all('SELECT id, checksum, applied_at FROM _migrations ORDER BY applied_at').catch(() => []);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    console.log('StockRidge migrations');
    console.log('──────────────────────────────────────────────────────────');
    console.log(`database : ${file}`);
    for (const f of files) {
      const name = f.replace(/\.sql$/, '');
      const hit = applied.find((a) => a.id === name);
      console.log(`  ${hit ? '✓' : '·'} ${name}${hit ? `  (applied ${hit.applied_at}, ${String(hit.checksum).slice(0, 12)}…)` : '  (pending)'}`);
    }
    const info = await schemaInfo(db);
    console.log(`objects  : ${info.tables} tables, ${info.views} views, ${info.indexes} indexes`);
    db.close();
    return;
  }

  const result = await migrate(db);
  console.log('StockRidge migrations');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`database : ${file}`);
  console.log(`applied  : ${result.applied.length ? result.applied.join(', ') : 'nothing (already up to date)'}`);
  if (result.skipped && result.skipped.length) console.log(`skipped  : ${result.skipped.join(', ')}`);
  const info = await schemaInfo(db);
  console.log(`objects  : ${info.tables} tables, ${info.views} views, ${info.indexes} indexes`);
  console.log('──────────────────────────────────────────────────────────');
  const seeded = await db.scalar('SELECT COUNT(*) FROM businesses').catch(() => 0);
  if (!seeded) console.log('empty database — run `npm run db:seed` for a demo deployment');
  db.close();
}

main().catch((e) => {
  console.error('\nmigrate failed:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
