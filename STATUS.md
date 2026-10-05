# StockRidge — build status

A running record of what is built, what is verified, and what is left. Kept in the
repository because the difference between "written" and "proven" is the whole
point of this project, and that difference is easy to lose.

**Last updated:** build `ridge-2` — all screens complete, audits clean, 247/247 tests passing.

---

## What StockRidge is

A multi-business, multi-branch inventory, POS and back-office platform for the
Nigerian market: appliances and gadgets, furniture, wholesale general merchandise,
and building materials. Built for a wholesaler or retailer with more than one shop,
more than one line of business, and a fleet of Android phones at the counters.

It is a decoupled reconstruction of the PharmaRidge engine. Everything
PharmaRidge solved that was not a *pharmacy* problem is carried across as an
engine concern: soft delete with `updated_at` on every mutable row, last-write-wins
sync with conflict capture, idempotency keys, hash-chained append-only registers,
partial unique indexes as "one open X per Y" guards, login throttling, West Africa
Time bucketing, VAT-inclusive extraction, withholding tax as data, and one stored
MANAGER role scoped by `branch_id`.

---

## Two backends, one codebase

| | Node (`server/`) | Cloudflare (`worker/`) |
|---|---|---|
| Database | SQLite via better-sqlite3 | D1 |
| Runtime | `node server/app.js` | Workers |
| Routes, services, domain | shared, unchanged | shared, unchanged |

The seam is one storage interface (`db.first/all/run/scalar/exec/batch/transaction`).
A transaction in a service is written queue-then-execute — reads awaited, writes
queued — because better-sqlite3 cannot span a microtask and D1 has no interactive
transactions at all, but both can commit an array of statements atomically.

The offline client stores its queue and cached rows in **IndexedDB**, not a
SQLite-WASM build: the server (or D1) is the system of record, and the device only
needs to keep working while the line is down.

---

## The client

`public/` is a no-build, no-framework, no-CDN PWA. `index.html` loads plain
scripts; `SR.api` is the single door to the server; `SR.store` is IndexedDB;
`SR.sync` pushes the outbox then pulls changes.

Twelve screens plus detail screens, all reachable from the sidebar:

Dashboard · Sell (POS) · Till & safe · Sales · Catalogue · Stock · Stocktake ·
Transfers · Purchase orders · Suppliers · Expenses · Customers · Instalments &
layaway · Deliveries & installs · Returns & warranty · Attendance · Staff ·
Accounting · Reports · Branches · Businesses · Subscription · Settings ·
Audit trail · Sync & offline · My account · Service jobs

---

## Defects found by executing rather than reading

Every one of these passed a code review and a syntax check. They were found by
calling the route.

| Where | Symptom |
|---|---|
| `POST /api/businesses` | Provisioned through a service signature that did not exist; failed on a foreign key |
| `GET /api/catalogue/profiles` | 500 `describeProfile is not defined` (missing import) |
| `POST /api/users` | 500 `ROLES is not iterable` (a frozen OBJECT spread as an array) |
| `POST /api/stocktakes` | 500 — `stocktake_lines` INSERT had 8 placeholders and 7 values |
| `POST /api/returns` (+approve) | `sale_return_items` INSERT: 12 placeholders, 11 values — every approved return failed |
| `POST /api/reports/targets` | `sales_targets` INSERT: one placeholder too many, and `newId` was never imported |
| `POST /api/tills/open` (from safe) | `branch_safe_ledger` INSERT: `till_session_id` had no value |
| `POST /api/tills/:id/close` (to safe) | same statement, same missing value |
| `POST /api/stock/adjust` | 500 `valid is not defined` (missing import) |
| Every multi-branch POST | Branch named in the body was ignored, so the request was refused as unspecific |

The last row is the most instructive: `resolveBranch()` read the query string and
the path, never the body — so a screen that had already been built to send
`{ branch_id }` or `{ from_branch_id }` could never work, on any deployment with
more than one branch.

---

## Guards that exist so those cannot come back

| Guard | Catches |
|---|---|
| `tools/sql-audit.js` | Column/value mismatches **and** placeholder/value mismatches in every literal statement |
| `tools/name-audit.js` | A function called that its file never imports or declares |
| `tools/service-args-audit.js` | A caller passing option keys the callee never reads |
| `test/e2e/frontend-routes.js` | A browser `/api` path with no server route; a route registered twice; a view the router can reach that does not exist |
| `test/e2e/screens.test.js` | Every read endpoint a screen opens, with its response shape asserted |
| `test/e2e/onboarding.test.js` | A client's first hour: fresh deployment → business → owner → stock → sale → ledger balances → till → stocktake |
| `test/e2e/repaired-flows.test.js` | The four repaired statements, driven end to end |

`npm run verify` runs the audits and the whole suite. The audits are themselves
tested, so they cannot silently stop checking.

---

## Seeding

A fresh deployment contains **one administrator and nothing else**: the settings
row, the 2024 withholding-tax schedule as data, and one ADMIN account with no
business and no branch.

Everything a business needs — chart of accounts, categories, customer classes,
price lists, a starter catalogue, branches, staff — is created through the app's
own screens, so the client's first action is to describe *their* business rather
than delete somebody else's demo.

    npm run db:reseed              # admin + a random PIN, printed once
    npm run db:reseed -- --pin=48213

---

## Still to do

- Cloudflare deployment: D1 database, Worker, migrations, admin-only seed, Pages.
- `docs/` — deployment, D1, storage/R2, GitHub Actions.
- `git init`, first commit, push to the client's repository.

# ---------------------------------------------------------------------
# DEPLOYMENT CHECKPOINT — live Cloudflare deployment
# ---------------------------------------------------------------------

**Last updated:** 2026-10-05 (checkpoint: Worker deployed, one blocking defect found and diagnosed)

## What is live

| Thing | Value |
|---|---|
| Account | `8c838389b678f2906c9a625bd35bdeb4` |
| D1 database | `stockridge` = `32aa519c-a7fb-41d5-bc5b-083d0a0489bc` (recreated; 77 tables, 22 views, 2 migrations recorded) |
| Worker | https://stockridge.stockridge.workers.dev (API + PWA in one deployment) |
| Admin | `admin` — seeded alone, no business, no branch, no catalogue (as the client handover requires) |
| Deploy tool | `tools/deploy-cloudflare.js` — verifies token, ensures D1, applies migrations, seeds, sets `JWT_SECRET`, deploys, smoke-tests |

The previous D1 (`dec228ef-…`, an earlier generation of this project with a
9-migration history and a demo business) was exported to
`.data/legacy-d1-20261004-full.sql` and then **deleted**, so the deployed schema
is exactly what `schema/migrations/` produces and a client deploy is reproducible.

## RESOLVED: PBKDF2 iteration cap on Workers — every sign-in was refused

`/api/diagnose` reported:

    FAIL PIN hashing round-trip
      Pbkdf2 failed: iteration counts above 100000 are not supported (requested 120000).

`domain/crypto.js` hashed PINs with `PBKDF2_ITERATIONS = 120000`. **Node accepts
that; the Cloudflare Workers WebCrypto implementation does not** — anything above
100,000 throws, `verifyPin` catches the throw and returns `false`, and every
sign-in on the deployed Worker answered `401 BAD_CREDENTIALS` while the identical
seed and code returned `200` on Node. All 251 local tests passed throughout.

### What was changed

| Change | Why |
|---|---|
| `PBKDF2_MAX_ITERATIONS = 100000`, `PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS` | One constant the platform can actually compute. Two values would let the ceiling go untested and the drift return. |
| `verifyPin` logs and returns false for a stored count above the ceiling | A silent `false` presents as "your PIN is wrong" for every user at once. Now it says so in `wrangler tail`. |
| `server/middleware/auth.js` dummy hash uses the constant | It hard-coded `120000` and would have kept failing after the constant was fixed, quietly disabling the anti-username-oracle timing defence. |
| `tools/d1-seed.js --reset` | `INSERT OR IGNORE` cannot replace a stored hash, so the deployed admin row — whose hash said `120000` — could never be verified. The flag rewrites the hash deliberately; a plain re-run still never touches a changed PIN. |
| Worker `/api/diagnose`: `PIN hashing round-trip` + `administrator sign-in lookup` | The check that found this. It exercises PBKDF2 in the runtime that will actually use it. Never remove it. |
| `tools/deploy-cloudflare.js` retries diagnose/sign-in for up to 2 minutes | A smoke test run straight after `deploy` can be answered by the previous version still warm in the isolate; a fixed deployment was reported broken for exactly this reason. |

### Verified live (2026-10-05)

    diagnose            ok: true — 6 checks pass (database, schema 77 tables, migrations,
                        administrator, PIN hashing round-trip, sign-in lookup)
    POST /api/auth/login 200 — admin / (5-digit PIN held by the operator)
    GET  /api/auth/me    200, role ADMIN, no business, no branch, scope allBusinesses
    GET  /api/businesses 200 []      GET /api/profiles 200      GET /api/plan 200
    /api/health/ready    503 awaiting_first_business  (correct: no shop exists yet)

## OTHER DEFECTS FOUND AND FIXED IN THIS STRETCH

1. **Every `/api/*` path 500'd when the database was unreachable or unmigrated** —
   the per-request settings middleware ran before dispatch and threw. Liveness
   answered 500, which is the one answer a liveness probe must never give, and
   readiness never reached the code written to explain the fault. Health paths
   now skip the settings load; every other path falls back to defaults and logs.
   Covered by `test/integration/health.test.js` (4 tests, all states).
2. **`/api/health/ready` said "not_ready" and told the operator to run
   `npm run db:seed`** on a handover deployment where that correctly does nothing.
   It now reports `awaiting_first_business` with the instruction that works:
   sign in as administrator and create the business.
3. **`tools/sql-audit.js` had a silent blind spot:** apostrophes in comments
   desynchronise its quoted-string scanner, so `server/middleware/auth.js`
   (27 odd single quotes: "Lagos's", "client's", "token's") had **zero** queries
   audited. A finding in `worker/src/index.mjs` proved the rule works; the file
   it never looked at is the login path.
4. **`deploy-cloudflare.js` printed a PIN that was not in effect** on a redeploy
   (the seed is `INSERT OR IGNORE`). It now asks D1 whether an administrator
   exists, says plainly that the existing PIN is unchanged, and offers
   `--reset-pin`. A smoke test no longer reports a 401 as a deployment fault when
   the stored PIN is simply unknown to the run.

**Test state:** 260/260 (`node --test test/unit/ test/integration/ test/e2e/`),
`sql-audit --strict` and `name-audit --strict` both exit 0.

## STILL OPEN (checked against the workspace, not memory)

Verified present: `public/js/views/sync.js` (31 KB) and `account.js` (12 KB) both
exist and are already in the service-worker precache list; `app.js` and `sw.js`
carry the same `BUILD = 'ridge-1'`; `public/js/views/instalments.js` defines
`takePayment(plan)` at module scope and calls it from the plan row — the defect
recorded earlier does **not** exist. Memory was stale on all four.

1. **GitHub: nothing is committed.** No git repository exists yet, and the target
   is `https://github.com/10client/stockridge`. `.gitignore` already excludes
   credentials, databases and `.data/`.
2. **`docs/` and `scripts/` do not exist.** Needed: deployment (this file's
   sequence in full), D1 operations, storage/R2, the GitHub Action, and a
   client handover note.
3. **No live browser smoke test of any screen.** Every screen is proven by
   contract tests and by the routes behind it; none has been rendered in a
   browser against the live deployment.
4. **The first-run journey has been proven on Node, not yet against live D1.**
   `POST /api/businesses` → provisioning → `POST /api/users` → sale is covered by
   `test/e2e/onboarding.test.js` and `test/integration/d1-seed.test.js` on
   SQLite. The D1 path runs the same routes over a different storage adapter
   (`worker/src/d1.js`, `batch()` for what Node does in a transaction), and that
   adapter has never executed a business creation against the live database.
   Plan: a `staging` environment on its own D1 database, run the whole journey
   there, and leave production at `awaiting_first_business`.
5. `public/offline.html` is absent. The service worker synthesises an offline
   page inline for a failed navigation, so the PWA still degrades correctly; a
   real file would be tidier, not more correct.
6. `tools/seed.js` (the demo fixture generator) is now dead weight for a client
   deployment. It should keep working for local development but must never be
   part of the handover path.
