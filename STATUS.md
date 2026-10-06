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

# ---------------------------------------------------------------------
# CHECKPOINT — three deployments, each with one administrator
# Last updated: 2026-10-05
# ---------------------------------------------------------------------

| Environment | URL | Database | State |
|---|---|---|---|
| **sample** | **https://sample.stockridge.workers.dev** | `stockridge-sample` = `fd72e95b-c0c8-4073-8aba-d3ca5919b107` | 6/6 diagnose, `awaiting_first_business` |
| production | https://stockridge.stockridge.workers.dev | `stockridge` = `32aa519c-a7fb-41d5-bc5b-083d0a0489bc` | 6/6 diagnose, `awaiting_first_business` |
| staging | https://stockridge-staging.stockridge.workers.dev | `stockridge-staging` = `abf164d9-f3bb-4e56-9a9f-addd795013f7` | 6/6 diagnose, `awaiting_first_business` |

Every one of them holds exactly: **1 user** (an `ADMIN`, no business, no branch),
10 withholding rates, 1 settings row. No businesses, no branches, no products, no
sales, no other accounts.

Verified at the database level on `sample`:

    users 1 | businesses 0 | branches 0 | products 0 | sales 0
    admins 1 | wht_rates 10 | client_settings 1
    the only user: admin / ADMIN / business NULL / branch NULL

`sample` is the deployment to show a prospective client: a real deployment on its
own database, not a demo mode, so they can set their business up in it and keep it.

## Sign-ins

| Deployment | Username | PIN |
|---|---|---|
| sample | `admin` | `48213` |
| production | `admin` | the PIN printed at deploy time (held by the operator) |
| staging | `admin` | `70614` |

## WHAT CHANGED

**`tools/deploy-cloudflare.js` gained `--env`.** It previously could only deploy
the default (production) configuration — a real gap, because every wrangler
command below the top level needs `--env` to see a binding declared inside an
environment, and the failure reads "Couldn't find a D1 DB with the name or binding
'x' in your wrangler.toml file", which sounds like a missing binding rather than a
missing flag.

- `D1_NAME` is derived from the environment (`stockridge`, `stockridge-sample`,
  `stockridge-staging`) so a sample can never write to production.
- `writeDatabaseId()` targets the section for **the environment being deployed**,
  and reports which other environments it left alone. Its history is worth
  recording: the first version rewrote every `database_id` in the file (correct
  while they all shared one database, and a silent disaster once they did not);
  the second hard-coded "top level and production" (right for production, wrong
  for everything else); the third derives it.
- The smoke test now **identifies the deployment before judging it**. Waiting for
  a URL to answer is not enough: `sample.stockridge.workers.dev` was answered by a
  legacy Worker of that name still warm at this edge, which has no
  `/api/auth/login` at all, and the first run reported that as a sign-in failure.
  It now requires the runtime marker and the PIN round-trip check that only this
  application has, and names what answered when it gives up.

## A NOTE ON `sample.stockridge.workers.dev`

The account already had a Worker called `sample` — an earlier generation of this
project. The deploy **replaced that script**, so the name now serves this
application. For roughly the first minute after deploying, requests for that
hostname can still be answered by the old version from a warm isolate. That is
propagation, not failure, and it is why the deploy tool retries and now checks
identity rather than mere reachability.

# ---------------------------------------------------------------------
# CHECKPOINT — verified against live Cloudflare D1
# Last updated: 2026-10-05
# ---------------------------------------------------------------------

`tools/verify-deployment.js` walks the client's first-run journey over real HTTP
against a real D1 database and asserts the RESULT of each step. Against staging:

    20 passed, 0 failed in 7s

    health → diagnose (6 checks) → readiness → administrator sign-in →
    create business → catalogue 20 products → chart of accounts 51 →
    create owner → owner sign-in → open till → receive 10 units →
    sell 1 → read the sale back → stock 9 of 10 → dashboard → sales report
    1 row → close till BALANCED ₦134,000 → sign out → token refused

Production runs the same code on its own database and its own Worker. Its
`/api/diagnose` reports all six checks passing and `readiness` reports
`awaiting_first_business`, which is the correct state for handover.

## WHY THIS WAS WORTH DOING: THREE DEFECTS, NONE VISIBLE TO THE TEST SUITE

The suite ran 260/260 throughout. Every one of these was found by running the
journey against a deployed Worker on D1.

### 1. Sign-out did nothing (security)

`server/middleware/auth.js` checked the session with
`if (session && session.session_id !== payload.sid)` — which reads as "reject a
token whose session was replaced" and actually means "accept a token whose
session was DELETED". Sign-out deletes the row. So the token kept working for its
full twelve hours, and on a shared till the next cashier inherited the previous
one's session. Found because the verifier signs out and then asks whether the
token still works — something nothing in the repository had ever done.

Fixed: a missing session row is now `401 SESSION_REVOKED`, a different one stays
`401 SESSION_SUPERSEDED`. Covered by `test/integration/sessions.test.js` (5 tests),
including a deactivated user and a session deleted behind the token's back.

### 2. The cron named two columns that do not exist (silent, unbounded)

The Worker's scheduled handler ran:

    UPDATE user_sessions SET is_deleted = 1 … WHERE expires_at IS NOT NULL …
    UPDATE branch_devices SET is_active = 0 … WHERE last_seen_at < …

`user_sessions` is (user_id, session_id, issued_at, updated_at) — no `is_deleted`,
no `expires_at`. `branch_devices` has no `is_active` and no `last_seen_at`. The
first statement threw, the try/catch logged one line, the second never ran: the
cron had done nothing since it was scheduled. Every static audit passed, because
the SQL is well-formed and only wrong about a schema that answers only when you
execute against it.

Fixed: the statements moved to `worker/src/housekeeping.js`, they use columns that
exist, and `test/integration/housekeeping.test.js` EXECUTES them against a
database built from `schema/migrations/`, including the boundary cases. The
`idempotency.prune` retention rule — documented in `idempotency.js` "for the cron
handler" and called from nowhere — is now actually called.

### 3. A user created for one business was recorded in another (data integrity)

`POST /api/users` resolved the business BEFORE the branch and passed an options
object into a parameter that expects a branch row. For the platform administrator
— who belongs to no business — the business then fell through to
`client_settings.primary_business_id` and finally to "the oldest live business".
An owner created for a branch of the SECOND business was stored against the FIRST,
with the second's branch attached, so their reports and dashboard were scoped to a
company they did not work for. Confirmed live: that user's sales report returned
zero rows for a business with a sale.

Fixed, in two places:
- `server/routes/admin.js` resolves the branch first and derives the business from
  it — a branch cannot be in two businesses, so this is a fact, not a preference.
- `server/lib/respond.js` now honours an explicitly requested `business_id` when
  the caller may reach it (so one owner can run several businesses), and REFUSES
  one they may not reach with `403 BUSINESS_SCOPE_VIOLATION` rather than silently
  substituting their own — the "successfully wrong" pattern again.
- `server/routes/reports.js` no longer applies a branch filter that belongs to a
  different business than the one being reported, which is what produced a clean
  200 with no rows for a company that had takings.

Covered by `test/e2e/multi-business.test.js` (3 tests) — the first tests in this
repository to provision TWO businesses in one deployment, which is the whole point
of the multi-business half of the product.

## ALSO FIXED

- **`--env` was missing from the deploy tool's wrangler calls**, so a staging
  deploy could not find a binding declared under `[env.staging]`.
- **`writeDatabaseId()` rewrote every `database_id` in `wrangler.toml`.** Correct
  while staging shared production's database; a silent disaster once staging had
  its own — a routine production deploy would have repointed staging at real
  sales. It now rewrites only the top-level and production bindings and says out
  loud if staging points at production. (The first version of the fix matched
  headers with `/^\[[^\]]*\]/`, which reads `[[d1_databases]]` as
  `[[d1_databases]` and matched nothing — a no-op reporting success. The probe
  caught it.)
- **The diagnose check looked for an administrator named `admin`**, so a
  deployment seeded with any other username reported a failure. It now finds THE
  administrator and reports which one, plus the hash format.

## INFRASTRUCTURE

| | |
|---|---|
| Production Worker | `stockridge.stockridge.workers.dev` — version `c957e2da-6684-48a6-97ff-369c47b364df` |
| Production D1 | `stockridge` = `32aa519c-a7fb-41d5-bc5b-083d0a0489bc` |
| Staging Worker | `stockridge-staging.stockridge.workers.dev` — version `847adf31-502b-4874-81e4-7e31e0392a8b` |
| Staging D1 | `stockridge-staging` = `01cfb608-05c0-4477-b867-5275c310132f` — **its own database**, so nothing tried in staging touches real takings |
| Staging sign-in | `stagingadmin` / `70614` |
| Production sign-in | `admin` / the PIN printed at deploy time |

Staging holds four verification businesses and four sales. That is deliberate:
staging is for exactly this. **Production holds one administrator and no
business at all**, which is the handover state.

## TEST STATE

    npm run verify  →  272 tests pass, three static audits clean under --strict

# ---------------------------------------------------------------------
# CHECKPOINT — the repository is on GitHub, and CI is green
# Last updated: 2026-10-05
# ---------------------------------------------------------------------

**Repository:** https://github.com/10client/stockridge — `main` @ `3e186ca`,
126 files, public, topics and description set, homepage pointing at the live
deployment. Local branch renamed from `master` to `main` to match.

## The old tree was not destroyed

The repository held an **earlier generation** of this project — last commit
`c6f562e` from 2026-10-04, with a single `schema.sql`, a `shared/` directory, a
top-level `wrangler.toml`, a nested `stockridge/` copy and a committed `.cache/`.
Rather than delete it, it is preserved at:

    branch  archive/pre-restructure-20261004  @  c6f562e

`main` was then replaced with the current tree as a single commit. The push goes
through `scripts/push-github.sh`, which reads the token from `.env.deploy`, uses
it for the duration of one push and never writes it into `.git/config`.

## TWO PUSH DEFECTS FOUND AND FIXED IN THE SCRIPT

1. **`--force-with-lease` refused with `stale info`** even though the fetched
   remote-tracking ref was right there. The bare form resolves its expectation
   from the *upstream of the branch being pushed*, and a fresh `git init` names
   that branch `master`, which has no upstream. It now names the ref and the SHA
   explicitly (`--force-with-lease=refs/heads/main:<sha>`), so the guard is real:
   if somebody else pushes in between, the push fails instead of overwriting.
2. **A fresh `git init` leaves the local branch called `master`**, so the next
   argument-less command would push the wrong thing. The script renames it to
   match the remote branch.

## REPOSITORY HYGIENE ADDED

| File | Why |
|---|---|
| `README.md` | The client-facing entry point: what it does, the two-backend diagram, the verticals, local development, the seven-step deploy, the first-run journey, the repository layout, and the PBKDF2 platform ceiling written down where an engineer will read it. |
| `.github/workflows/ci.yml` | Two jobs, because the two backends fail differently. `verify` (Node 20) runs the three audits and the tests; `worker-bundle` (Node 22, no credentials) runs `wrangler deploy --dry-run`, which is the fifteen-second check that would have caught the service-worker module-format bug. |
| `.github/workflows/deploy-cloudflare.yml` | **Manual only.** Deploying to production and seeding an administrator on every push takes that decision away from the person who should make it. Takes `reset_pin` and `dry_run` inputs and runs `npm run verify` first. |
| `.gitattributes` | LF everywhere (`*.sql` is read by two runtimes), binary declarations, lockfile excluded from diffs. |
| `.editorconfig` | Two-space indent, because a 4-space reindent of a 500-line route module hides the real change. |
| `SECURITY.md` | How credentials are handled, the authentication design, the authorisation model, and the iteration ceiling as a security-relevant constraint. |
| `.env.deploy.example` | The deploy credential template, with no values. |
| `scripts/push-github.sh` | Reproducible authenticated push without storing a token. |
| `package.json` | **Two dead scripts found by reading, not running:** `worker:seed` called `--print-sql`, a flag `tools/d1-seed.js` does not have; `pages:deploy` called `tools/deploy-pages.js`, which does not exist (the Worker serves the PWA from its assets binding, so there is no Pages project). Both replaced; `dbg.js`, a scratch file with absolute paths, deleted. |

## VERIFIED

    GitHub Actions run 37335694764 — success, 73s
      job  Audits and tests (Node 20)   success
      job  Worker bundle (Node 22)      success

    npm run verify (local, on the committed tree) — 260 tests pass,
    three static audits clean under --strict

The Worker job passing on a clean GitHub runner is the meaningful one: it proves
the bundle builds on a machine that has never seen this project.

## SANDBOX FACTS WORTH KNOWING FOR THE NEXT TURN

This workspace does **not** preserve `node_modules/` or `.local/` across a turn
boundary — both are excluded from the snapshot. Consequences:

- `npm install` must be re-run before any test run that touches SQLite
  (`better-sqlite3`); without it, the 10 database-backed test files fail with
  `Cannot find module 'better-sqlite3'` and the count reads 117/127 instead of
  260/260. The audits and the pure-domain unit tests pass regardless, which is
  exactly how that failure can be misread as a code regression.
- **Node 22 is gone.** Wrangler 4 requires ≥22, so any deploy needs it
  re-installed first:
  `nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz` → `/home/user/.local`.
  The `node` on PATH is the system **v20.20.2**.

## STILL OPEN (checked against the workspace, not memory)

Verified present: `public/js/views/sync.js` (31 KB) and `account.js` (12 KB) both
exist and are already in the service-worker precache list; `app.js` and `sw.js`
carry the same `BUILD = 'ridge-1'`; `public/js/views/instalments.js` defines
`takePayment(plan)` at module scope and calls it from the plan row — the defect
recorded earlier does **not** exist. Memory was stale on all four.

1. ~~`docs/` does not exist~~ — **written** (`docs/`: deployment, D1 operations,
   storage/R2, CI/CD, client handover, troubleshooting, index). 7,400 words, every
   path and command in them checked against the tree.
2. **No live browser smoke test of any screen.** Every screen is proven by
   contract tests and by the routes behind it; none has been rendered in a
   browser against the live deployment.
3. **The first-run journey has been proven on Node, not yet against live D1.**
   `POST /api/businesses` → provisioning → `POST /api/users` → sale is covered by
   `test/e2e/onboarding.test.js` and `test/integration/d1-seed.test.js` on
   SQLite. The D1 path runs the same routes over a different storage adapter
   (`worker/src/d1.js`, `batch()` for what Node does in a transaction), and that
   adapter has never executed a business creation against the live database.
   Plan: a `staging` environment on its own D1 database, run the whole journey
   there, and leave production at `awaiting_first_business`.
4. `public/offline.html` is absent. The service worker synthesises an offline
   page inline for a failed navigation, so the PWA still degrades correctly; a
   real file would be tidier, not more correct.
5. `tools/seed.js` (the demo fixture generator) is now dead weight for a client
   deployment. It should keep working for local development but must never be
   part of the handover path.

---

# CHECKPOINT — 2026-10-06: three environments, and the empty sidebar

**Last updated:** build `ridge-2`, `npm run verify` → **278 tests, 278 pass**,
`sql-audit`/`name-audit`/`args-audit --strict` all clean. Three live deployments,
each verified in a real DOM.

## The empty sidebar — the defect that made the whole app look broken

The report was "I could not see anything on the nav bar to work with as admin".
It was not an admin problem, and it was not a single deployment. It was **every
role on every environment, from the first session load.**

`state.js` did this:

```js
const state = { user: null, /* … */ };
SR.state = Object.assign(state, { branches, businesses, /* … accessors */ });
```

`Object.assign` copies the *functions* onto `state`, so `SR.state.branches` is an
accessor — and then `load()` ran `state.branches = data.branches` from the session
response, replacing the function with the **array**. From then on every
`SR.state.branches()` threw `is not a function`.

That throw happened inside `paintIdentity()`, which `showShell()` called *before*
`buildNav()`. The exception propagated out of `showShell()`, so `buildNav()` never
ran and the sidebar was never populated. One overwritten key on one object made
the application look completely dead while every route behind it answered 200 —
which is exactly why 247 passing tests and a green deployment smoke test never saw
it. The tests call the routes; they never rendered the shell.

### The fix

1. **`public/js/state.js`** — raw rows now live under names that cannot collide:
   `businessRows` / `branchRows`. The accessors `businesses()` / `branches()` read
   those. A data field can no longer overwrite a method on the same object. A long
   comment in the file records the defect so nobody re-introduces it.
2. **`public/js/app.js`** — `showShell()` wraps `paintIdentity()` in `try/catch`,
   so a header failure can degrade the header and still leave the navigation
   standing. A cosmetic failure must never be able to remove the way out.

### Two regression guards, because the test suite was blind to this

- **`test/unit/frontend-state.test.js`** (6 tests) — runs the real `state.js`
  against a stub window, calls `load()` with a session payload, then asserts the
  accessors are *still callable and still return the right rows*. Plus a static
  audit that every `SR.state.<name>()` call site anywhere in `public/js/` names an
  accessor that actually exists, which catches the same class of typo from the
  other direction.
- **`tools/frontend-smoke.js`** — a real browser-shaped client. Loads
  `public/index.html` in jsdom against a live server, signs in, boots the app,
  and reports the nav items that were actually rendered into the DOM:
  `--url`, `--user`, `--pin`, `--all-roles`, `--expect-nav=N`. This is the check
  that would have caught the defect on day one, and it now runs against live
  deployments as well as the local demo database.

**Nav verified in a real DOM.** Local seeded demo database, all four roles:
ADMIN **7** · OWNER **25** · MANAGER **21** · STAFF **12** items, every screen
reaching "Ready." rather than an error state. Then the same check against all
three live deployments as `admin`: **7 items each, every time.**

## Three live environments, three Workers, three D1 databases

| `--env` | URL | D1 database | sign in |
|---|---|---|---|
| `sample` | **https://sample.stockridge.workers.dev** | `stockridge-sample` · `fd72e95b-c0c8-4073-8aba-d3ca5919b107` | `admin` / `48213` |
| *(default)* production | https://stockridge.stockridge.workers.dev | `stockridge` · `32aa519c-a7fb-41d5-bc5b-083d0a0489bc` | `admin` / `48213` |
| `staging` | https://stockridge-staging.stockridge.workers.dev | `stockridge-staging` · `abf164d9-f3bb-4e56-9a9f-addd795013f7` | `admin` / `70614` |

All three: **1 user (the administrator), 0 businesses, 0 branches, 0 products,
0 sales**, 10 withholding-tax rates, 1 settings row. Diagnose **6/6**, readiness
`awaiting_first_business`, all carrying the nav fix. `sample` is the one to hand a
client — it is where a fresh deployment's first-run experience is demonstrated.

`--env=sample|staging` derives the D1 name (`stockridge-<env>`) and rewrites
**only** that environment's `[[env.<name>.d1_databases]]` block, reporting the
other environments as untouched. This is what makes three parallel environments
safe to operate from one script.

## What was learned about deploying

- **A legacy Worker named `sample` already owned that hostname.** The deploy
  replaced the script, and for about a minute the *old* version still answered
  requests — its `/api/auth/login` 404'd and its health endpoint said
  "StockRidge". A smoke test that only checks reachability would have passed.
  The deploy smoke test now verifies **identity**: the
  `runtime: 'cloudflare-workers'` marker plus a real PIN round-trip sign-in.
- **401s on `/api/profiles` and `/api/plan` immediately after `--reset-pin` are
  propagation, not defects.** `--reset-pin` rotates `JWT_SECRET`; during the
  rollout a token can be issued by one isolate and validated by another. Every
  endpoint answered 200 on a re-probe 25 seconds later. The deploy smoke test now
  retries those first-run screens on a 401 the same way it retries sign-in, so a
  rollout never reports a failure that is not one.
- **`npm install --no-save jsdom` on its own prunes `fake-indexeddb`** and vice
  versa. Install both in one command. The frontend smoke test needs three things
  jsdom does not supply: `fake-indexeddb` (the app's offline store, without which
  boot aborts), a `matchMedia` polyfill, and `window.scrollTo`.

## Commands

```
node tools/frontend-smoke.js --url=… --user=admin --pin=48213          # one seat, live
node tools/frontend-smoke.js --all-roles                              # every role, local demo DB
node tools/deploy-cloudflare.js --env=sample [--reset-pin] [--pin=N]
node tools/verify-deployment.js --url=… --username=… --pin=…          # the full journey
```

## Addendum: the journey proved on live D1, and two defects in my own tools

### The full first-run journey now runs against live Cloudflare D1 — 20/20

`node tools/verify-deployment.js --url=https://stockridge-staging… --username=admin --pin=70614`
→ **20 passed, 0 failed in 21s**, against real D1, not SQLite:

sign in as administrator → create the business (`ELECTRONICS`, new branch) →
**D1-side provisioning built 20 starter products and 51 chart-of-accounts rows** →
create the owner → sign in as the owner, correctly scoped → open a till with a
₦100,000 float → receive 10 units → sell one for ₦34,000 → read the sale back →
stock down to 9 → dashboard and sales report both count it (₦34,000 gross,
₦2,372.09 VAT — the 7.5% VAT-inclusive extraction, on D1) → close the till
(counted ₦134,000, expected ₦134,000, variance ₦0) → sign out → **the retired
token is refused**.

That closes the item recorded as "proven on Node, not against live D1". Then the
same business was rendered through the frontend as a real scoped owner: nav **25**
items, dashboard showing the live sale, and the admin seat on the same database
showing **7**. The API, the D1 adapter, the provisioning and the screens all agree.

### Two defects found in the tools themselves — both would have hidden real ones

**1. The smoke test raced the app and cried wolf.** `frontend-smoke.js` slept a
flat 6 seconds and then inspected the DOM. On a live deployment a *first* boot
signs in, then syncs the whole catalogue into IndexedDB, and on real D1 data that
takes longer than six seconds — so the tool reported `nav 0: (EMPTY)` on a
perfectly working app. That is the exact symptom of the defect the tool was built
to catch, reported for the wrong reason, which is the worst way for a test to be
wrong. It now **polls until the app settles** (navigation built and a view
rendered, or a visible failure), with `--wait=N` and a 30 s ceiling.

**2. "jsdom is missing" when jsdom was installed.** The CI job's `require('jsdom')`
threw, and the tool's catch-all printed "this tool needs jsdom" and told the reader
to install a package that was already there. The truth: CI ran Node 20.11, the
unpinned install pulled **jsdom 30** (engine `^22.22.2`), and it could not load.
Told the wrong story by my own error message, I would have gone looking for a
missing package. Now: the catch prints the underlying error and the Node version,
and CI pins `jsdom@29.1.1` + `fake-indexeddb@6.2.5` on **Node 22**.

### CI now renders the app

`.github/workflows/ci.yml` gained a third job, `frontend-render`: seed the demo
database, start the server, render `public/index.html` in jsdom and assert the
navigation actually reaches the DOM for **all four roles**. The deploy workflow
gained an optional post-deploy render (`verify_frontend`, off by default because it
needs the live PIN as a repository secret) — the sidebar defect appeared only on a
live deployment, so a deploy-time check belongs there.

`node tools/frontend-smoke.js … --dump` is new: it prints the visible screen, the
DOM state and the page's own console, so the next person does not have to guess why
a seat did not render.

---

# CHECKPOINT — 2026-10-06 (2): what the Sell screen did when a cashier used it

**Last updated:** `npm run verify` → **284 tests, 284 pass**, audits clean. Three
live deployments carry this. Every defect below was found by *driving the real
screen*, not by testing the API — and every one of them was invisible to 284
passing tests.

`tools/frontend-sale.js` is new: it opens the real Sell screen in a jsdom client
against a real server, searches a product, adds it to the cart, takes the payment,
completes the sale and reads the receipt back:

```
node tools/frontend-sale.js --url=https://stockridge-staging.stockridge.workers.dev \
  --user=<seat> --pin=<pin> --product=Anker
```

Five defects, in the order the cashier hit them.

## 1. The till sent a unit NAME where the API wanted a CODE — nothing was sellable

```
Line 1 ("Anker 20000mAh Power Bank"): Unknown unit "UNIT".
This product is sold in: PIECE, CARTON.
```

The appliance ladder names its base unit **"Unit"** under the code **PIECE**. The
product row carries `base_unit_name` ("unit") because that is the word a *receipt*
prints, and `public/js/views/pos.js` sent it as if it were a code — uppercased to
`UNIT`, which is not in the ladder. Search worked, the cart worked, the payment was
taken, and the sale was refused at the last moment: on every appliance and gadget
in the catalogue.

It survived 284 tests because every test sent `unit_code: 'PIECE'`. The
hand-written payload was more correct than the application.

**Fixed in three places, deliberately:**

- **`domain/uom.js`** now resolves a unit by CODE or by NAME (and plural), because
  callers legitimately hold either. Ambiguity is refused (`AMBIGUOUS_UNIT`) rather
  than guessed: if one word names two levels, choosing between them is the bug, not
  the fix. This is the layer that makes an *already queued* offline sale — a payload
  written by the old build, sitting on a phone — sync successfully instead of being
  rejected forever.
- **`GET /api/products`** carries `default_unit_code`, so no screen has to guess.
- **`pos.js`, `purchase-orders.js`, `instalments.js`** use the code, falling back to
  the word only if the code is absent.

`test/integration/sale-units.test.js` (6 tests) pins all of it, including a sale
posted with the exact payload the till sent (`unit_code: 'unit'`) and a check that
the catalogue still contains a product whose unit name differs from its code — so
the test cannot quietly stop testing the thing that broke.

## 2. A product priced in the wrong unit — ₦300 for ₦14,400 of water

The till switched to the default sell unit (a **carton** of water) but kept the
**base** price (₦300 a bottle). It quoted the customer ₦300, took ₦300, and the
server — which had always priced it correctly at 48 × ₦300 — refused the sale for a
₦14,100 short payment. The money was never wrong; what the customer was shown was.

**Fixed:** the catalogue now reports `default_unit_factor` beside the code, and the
cart prices a line in the unit it is selling (a carton is ₦14,400 *because* a carton
holds 48 bottles). `U.round2(basePrice * sell.factor)`.

## 3. Variant goods could not be sold from search at all

Ten of the demo catalogue's 78 products are variant-tracked — sofas in three
fabrics, phones in four colours, beds in nine finishes. Clicking one in search put
it in the cart with no variant, and the refusal only came at payment:

```
Line 1: "3-Seater Tiffany Fabric Sofa" comes in variants — choose the specific one
(colour, size or finish) the customer is buying.
```

The endpoint always said so. The screen never asked. **Fixed:** the Sell screen now
opens a variant chooser when the product has variants (with each variant's own price
and stock), and a line that somehow reaches the cart without one carries a
"Choose variant" button rather than an unsellable line.

## 4. A wholesale branch could not sell a single piece

The kettle's default sell unit at a wholesale branch is the CARTON. The shelf held
sixteen pieces, so the till demanded 48 and refused:

```
only 16 pieces of "Binatone Kettle 1.8L" is available at this branch, and this line
needs 48. Short by 32.
```

and nothing on the screen offered a way to sell one piece — the ladder was in the
database all along. **Fixed:** the cart line carries a `Unit: CARTON` button that
switches the unit and re-prices the line from the catalogue price per base unit,
with the available quantity re-expressed in the chosen unit.

## 5. Two ways a completed sale produced no receipt

- **The receipt was created and then deleted.** `completeSale()` opened the receipt
  while the payment sheet was still up, and the payment sheet's `close()` clears the
  one modal root — so *every* sale ended on an empty cart with no receipt, no
  confirmation and nothing to print. **Fixed:** the caller closes the payment sheet
  first, then shows the receipt.
- **Warranty receipts threw.** The warranty block computed an expiry from
  `U.soldDate()`, which is a *display* string ("05 Oct 2026") — and
  `new Date("05 Oct 2026T00:00:00Z")` is an Invalid Date whose `toISOString()`
  throws `RangeError: Invalid time value`, taking the whole receipt with it. So a
  warrantied appliance — the entire point of this vertical — produced no receipt at
  all. **Fixed:** a new `U.isoDate()` for arithmetic (`soldDate()` stays for people),
  a warranty line that prints the period when the date is unreadable, and a
  try/catch so a layout fault can never cost a cashier the receipt for a sale that
  is already recorded.

## What this says about the testing

Everything here was found in one stretch of operating the screen, by a tool that
takes a minute to run. The suite had 284 tests and every one of them passed while a
cashier could not sell a kettle. Contracts test the API; they cannot test the till.
`frontend-smoke.js` asks whether the app renders; `frontend-sale.js` asks whether it
can be *operated*. Both now exist, and both run against a live deployment.

## Verification

- `npm run verify` → 284 tests, 284 pass; `sql-audit`, `name-audit`, `args-audit` clean.
- Sales rung through the real Sell screen, to a printed receipt, with the server
  confirming each: a tile (variant, `SQUARE_METRE`), a carton of water (₦14,400,
  multi-unit), a warrantied kettle (₦19,500, warranty expiry 2027-10-05).
- All three environments deployed with these fixes: staging (1 business trading),
  sample and production (admin-only handover state, readiness 6/6).

## Live verification of the till fixes (2026-10-06)

- **A warrantied appliance sold through the real Sell screen on Cloudflare D1:**
  staging, a scoped owner, the Anker power bank at ₦34,000 → **receipt 000008,
  status COMPLETED**, read back from `GET /api/sales`. This is the case that twice
  before ended with "Unknown unit" and then "Invalid time value".
- **All 25 owner screens walked on the live deployment** after the fixes: every one
  renders, none blank.
- **All three environments** render the shell for the administrator (nav 7) and
  report `no problems`: `sample` and `stockridge` at the admin-only handover state,
  `stockridge-staging` trading a verification business.
- Sales rung end to end through the screen, each confirmed by the server: tile
  (variant, `SQUARE_METRE`, ₦7,600), carton of water (multi-unit, ₦14,400),
  warrantied kettle (₦19,500, warranty expiry 2027-10-05), power bank on D1 (₦34,000).

---

# CHECKPOINT — 2026-10-06 (3): the receiving side

**Last updated:** `npm run verify` → **289 tests, 289 pass**. `tools/frontend-receive.js`
is new: it receives stock through the real Stock screen and then asks the server what
happened, in base units.

```
node tools/frontend-receive.js --url=… --user=<seat> --pin=<pin> --product=kettle --qty=3
```

Three more defects, all in the same place a shop's money enters the books.

## 6. Stock could not be received from the screen at all

The form posted `cost_price_per_unit`. The endpoint reads `cost_price`. So every
attempt through the interface was answered:

```
Cost price is required.
```

Receiving was impossible from the UI — the API path was tested (the deployment
verifier posts `cost_price`) and the screen was not. The form now sends the field
names the endpoint reads, and the endpoint also accepts the old `_per_unit`
spellings, so a payload written by an older client is not silently lost.

## 7. Freight was never recorded

The form posted `freight_per_unit`; the endpoint reads `freight_cost`, as a
consignment total spread over the units received. It was ignored in silence, so
clearing and carriage never reached the cost of the goods — which is the difference
between a real margin and a flattering one. The form now asks for the delivery's
freight as a total, which is also what a clearing invoice shows.

## 8. Receiving zeroed the product's cost

`weightedAverageCost` read `cost_price_per_unit` from each row, and **both** of its
callers — the receiving route and purchase-order receiving — pass `{ quantity, cost }`.
So every cost averaged as zero and `products.cost_price` was written as **0** on
receipt into a product that already had stock. That figure is the margin on the next
sale, the value of the shelf and the VAT split; it stayed wrong until somebody
noticed the cost column reading ₦0.00. It now reads either shape (`??`, so a
genuine cost of zero survives), and `test/integration/stock-receive.test.js` (5
tests) pins the endpoint the way the screen calls it, the legacy names, a unit
name, and the arithmetic the callers actually hand it.

## 9. A stuck button on every failure path — in a dozen places

Found on the receiving form's error path, which is where nobody looks:

```js
catch (err) {
  ui.apiError(err);
  ev.currentTarget.disabled = false;     // TypeError: null
  ev.currentTarget.textContent = 'Receive';
}
```

The DOM clears `currentTarget` the moment dispatch ends, and `await` ends it. So the
catch block itself threw and the button stayed on "Recording…", disabled, for ever —
the cashier could not retry without reopening the form. The same pattern appears in
about a dozen handlers across the views. Fixed once in `ui.h`: every handler is now
given an event whose `currentTarget` stays valid for the whole of its work, with a
fallback for any runtime without `Proxy`. Every failure path in the application
recovered its button and its error message from that one change.

## Verified

- `npm run verify` → **289 tests, 289 pass**, audits clean.
- Receiving through the screen: stock 30 → 33 for 3 pieces, batch cost
  ₦11,917.93 — exactly the weighted average the form offered.
- Selling through the screen, same database, after the fixes: **receipt 000653,
  ₦19,500, COMPLETED**.
- The demo database was reseeded: the old bug had zeroed product costs in it.

## Also in this stage

- **The cost box no longer prefills ₦0.** An unknown cost is left empty so the figure
  has to come off the invoice: pre-filling zero booked free stock, and the live
  staging run proved it — a batch was recorded at ₦0 because the product's cost had
  been zeroed by defect 8. It now offers the real weighted average (₦9,520 for the
  power bank) or nothing at all.
- **Live verification:** receiving through the real Stock screen on Cloudflare D1 —
  `stock 5 → 8` for 3 pieces, batch cost ₦25,000 exactly as typed. All three
  environments redeployed (15 checks each) and pushed.

---

# CHECKPOINT — Stage 5, part 1: THE OUTBOX THAT NEVER CLEARED

## The symptom

Selling with the line cut worked, the sale reached the server, the receipt was
issued — and the device's outbox stayed **PENDING** for ever. The Sync screen would
have shown one sale waiting indefinitely; the device would have re-sent it on every
later sync, for ever. On a busy counter that is an unbounded stream of duplicate
posts, each one of which the server would have had to recognise and refuse.

## The cause: the happy path was the only path that broke

`server/routes/sync.js` wrote its bookkeeping row after every push:

```js
INSERT INTO sync_change_log (…, status, …) VALUES (…, ?, ?, …)
  → rejected > 0 ? 'PARTIAL' : 'OK'
```

The column is constrained:

```sql
status TEXT NOT NULL CHECK (status IN ('SUCCESS','PARTIAL','FAILED'))
```

So a push in which **nothing was refused** violated the CHECK, the whole request
answered **400** — *after* the operations had already been applied — and the device
never received the per-item results it uses to mark its queue. Every push in which
something was refused answered 207 and behaved correctly, which is why the fault
survived every test: **every sync test in the suite pushed something invalid.**

This is why the earlier run reported `applied: 0` while the sale was plainly in the
books, and why the server received one receipt per offline sale: the client re-sent
until the server's idempotency keys recognised the work, and journaled each attempt
as a failure.

## The fixes

- `server/routes/sync.js` — the status is `'SUCCESS'`, not `'OK'`. The Worker imports
  this same route file, so **one change fixed both backends**.
- `public/js/sync.js` — a push that fails outright now writes the reason onto each
  queued row (`last_code`, `last_error`) instead of leaving the Sync screen with a
  count that never moves and no explanation. Nothing is discarded.
- `test/e2e/api.test.js` — **a sync push that APPLIES**, which the suite never had:
  it pushes a real sale, asserts **200** and `APPLIED`, checks the sale is in the
  books, pushes the identical operation again and asserts `ALREADY_APPLIED` with the
  **same** sale id. Pushing twice is precisely what a device with a stale outbox does,
  so the exactly-once promise is now locked down by a test rather than by hope.

**Proven to fail on the old code**: with `'OK'` restored, the new test fails with the
production error verbatim — `The figures do not add up: status IN
('SUCCESS','PARTIAL','FAILED') … CHECK_FAILED`. A regression test that passes on the
broken code would have been worthless.

## Verified end to end (local, `tools/frontend-offline.js`)

```
✓ the app knows the line is down          api.isOnline() is false
✓ found the product with no line          Binatone Kettle 1.8L · ₦19,500 (device results)
✓ the sale was recorded on the device     Offline sale recorded · ₦19,500.00
✓ it is in the outbox, waiting            status PENDING
✓ the device synced                       1 sent, 0 refused, 1 rows received
✓ the sale reached the server, exactly once   receipt 000659 · ₦19,500.00
✓ the outbox is clear
```

The tool now reports the sent count from the outbox's own server references, because
the app syncs by itself the moment the line returns — reporting the explicit
`runOnce()`'s bare zero said "nothing was sent" about a sale already in the books.

- `npm run verify` → **290 tests, 290 pass** (was 289; +1 the happy-path sync test).

---

# CHECKPOINT — Stage 6a: THE SUBSCRIPTION SCREEN THAT COULD NOT DRAW ITSELF

## What the user saw

As the platform administrator, opening **Subscription** gave a red block reading
*"That failed. Cannot read properties of null (reading 'name')"*.

## The cause

```js
ui.h('p', { class: 'sub' }, `${SR.state.activeBusiness().name} · the plan …`)
```

`activeBusiness()` returns **null** on any deployment that has no business yet — which
is the state every fresh installation starts in, and the state an administrator is in
until they run the first provisioning. Reading `.name` off it threw before the screen
had drawn anything.

**The same line was in five screens**, and only one of them was in a role's navigation
at the time:

| screen | route | who reaches it |
|---|---|---|
| `plan.js` | `/plan` | OWNER, **ADMIN** ← how it was noticed |
| `accounting.js` | `/accounting` | OWNER |
| `reports.js` (×2) | `/reports` | MANAGER, OWNER |
| `account.js` | `/account` | every role |

An owner or manager on a brand-new deployment would have hit it on their first day.
All five now use a new `SR.state.activeBusinessName(fallback)`, which returns the
business's name, or the deployment's own name, or a short true phrase — and can never
throw.

## Why the smoke walk did not catch it, and now does

A screen that REFUSES ("Open a till first") renders the same red block as a screen
that BROKE. The walk treated any alert as a deliberate refusal and moved on — so a
page that could not draw itself passed the walk cleanly. That is how this shipped.

`tools/frontend-smoke.js` now reads the message: `Cannot read propert…`, `is not a
function`, `is not defined`, `of null`, `of undefined`, `not iterable` and their
kind are **faults**, and a fault is a **problem** that fails the walk, reported with
the screen's label and its route.

## Both halves of the probe, run for real

Against a freshly reseeded, business-less database (`.data/adminonly.db`, one admin):

- **With the fix** — all seven administrator destinations render:
  `Dashboard · Staff · Branches · Businesses · Subscription · Settings · Sync & offline`,
  the Subscription screen reading *"No business yet · the plan this deployment runs on…"*.
  **1 seat checked, no problems.**
- **With the fix reverted** — the same walk reports
  `! Subscription 69 char That failed. Cannot read properties of null (reading 'name')`
  and then **`1 problem(s): the Subscription screen (/plan) failed to render itself`**.

## Locked down in CI

`test/unit/frontend-state.test.js` gains two tests:

1. **A deployment with no business yet still names itself** — loads the real
   `state.js` with `businesses: []`, asserts `activeBusiness()` really is null
   (so the test is meaningful) and that `activeBusinessName()` returns the
   deployment's name without throwing.
2. **No screen dereferences a business that may not exist** — a source scan for
   `activeBusiness().` / `activeBranch().` anywhere in `public/js`. This is the rule
   the defect broke, enforced from now on rather than remembered.

Writing that second test immediately found the defect again: an edit earlier in this
session had left `plan.js` on the old line while I believed it was fixed. A test that
finds the bug it was written for, twice, in the same hour, is doing its job.

## Verified

- `npm run verify` → **292 tests, 292 pass** (was 290).
- Administrator walk on an empty deployment: 7 destinations, no problems.
- The reverted-code run fails, naming the screen and the route.

# CHECKPOINT — Stage 6b: THE PIN IS 1234 EVERYWHERE, AND THE SCREEN IS FIXED LIVE

## One administrator PIN across the whole estate

The platform administrator's PIN is now **1234** on all three environments, set
through the deployment tool so only the hash is stored and the PIN is never written
into the repository:

| environment | URL | administrator | PIN |
|---|---|---|---|
| `sample` | https://sample.stockridge.workers.dev | `admin` | **1234** |
| production (default) | https://stockridge.stockridge.workers.dev | `admin` | **1234** |
| `staging` | https://stockridge-staging.stockridge.workers.dev | `admin` | **1234** |

Staging keeps its own credentials for the business it already runs: owner
`liveseat`, whose PIN was set with the admin one in this round.

## Proved in both directions, on each environment, live

A PIN change is only done when the new one works **and the old one does not** — an
unchanged old PIN would mean the reset silently did nothing:

```
sample.stockridge.workers.dev        1234  NEW  http 200 -> token
sample.stockridge.workers.dev        48213 OLD  http 401 -> BAD_CREDENTIALS
stockridge.stockridge.workers.dev    1234  NEW  http 200 -> token
stockridge.stockridge.workers.dev    48213 OLD  http 401 -> BAD_CREDENTIALS
stockridge-staging…workers.dev       1234  NEW  http 200 -> token
stockridge-staging…workers.dev       70614 OLD  http 401 -> BAD_CREDENTIALS
```

## The Subscription screen, live, as the administrator

Signed in to **sample** as `admin` / `1234` and walked every destination in the
navigation the administrator actually gets:

```
nav 7: Dashboard · Staff · Branches · Businesses · Subscription · Settings · Sync & offline
  · Dashboard       334 char
  · Staff           824 char
  · Branches        295 char
  · Businesses      398 char
  · Subscription   1972 char  SubscriptionNo business yet · the plan this deployment runs on…
  · Settings       1146 char
  · Sync & offline 1299 char
1 seat(s) checked, no problems.
```

**"That failed. Cannot read properties of null (reading 'name')" is gone.** The screen
now says it has no business yet — which is true, and is the administrator's cue to go
and create one.

All three environments were redeployed with 15 checks each and reported ready.

---

# CHECKPOINT — Stage 7: EVERY ROLE, EVERY CAPABILITY, PROBED BOTH WAYS

## What was asked

*"Make sure all the capabilities possible from the schema are fully utilised by all
the forms of users, and probe a two-way probe on all aspects of the app, in stages."*

## What was built

`tools/frontend-roles.js` — a probe that signs in as each kind of user and answers two
questions at once:

1. **Does this role get what the roles table says it gets?** The navigation the app
   hands the seat is compared against the destinations the route table declares for
   that role.
2. **Is this role actually refused what it may not do?** Every guarded endpoint the
   server registers is called with that role's token. Below the guard: 403 required.
   At or above it: anything but a 403. A 5xx anywhere is a defect.

The second question is the one nothing in this repository asked before, and it is the
one that matters most: a capability that is missing is reported by a user within a
day, while a capability that is **not refused** — a cashier reading the profit
figures, a manager editing the control switches — is reported by an auditor, if ever.

The walk that decides "is this screen broken?" now lives in
`tools/lib/page-harness.js` and is shared by the smoke test and this probe, so both
use one definition — including the fault-versus-refusal judgement that the
Subscription defect made necessary.

## The instrument, measured against the app

```
164 route(s) registered · 54 carry a role guard
per seat: 6 guarded GET(s) called (+48 guarded writes with --deep-writes)

✓ admin (ADMIN)     6 navigation destinations   ·  5 answered, 0 refused, 0 broken
✓ owner (OWNER)    25 navigation destinations   ·  5 answered, 1 refused, 0 broken
✓ emeka (MANAGER)  21 navigation destinations   ·  4 answered, 13 refused, 0 broken
✓ blessing (STAFF) 12 navigation destinations   ·  0 answered, 25 refused, 0 broken
  declared for STAFF: 12 — every destination the route table grants a cashier
```

Every role's sidebar equals its declaration, exactly. A cashier answers **none** of
the 25 guarded boundaries it is not entitled to. No screen in any of the four
navigations fails to render — 65 destinations walked in one run, no faults.

**Live on staging**, as `admin` and as the owner `liveseat`: clean, both directions,
25 destinations for the owner, 54 guards examined.

## Proving the probe can fail — twice, by breaking the app on purpose

A probe that reports "no problems" on a broken app is worse than no probe. Both
failure modes were constructed:

1. **A guard that exists in the source but does not run** (`if (false && !atLeast(…)`).
   Caught: *"GET /api/plan was served http 200 to MANAGER, and the subscription
   position belongs to the owner — it must require OWNER"*, and the same for STAFF.
2. **A guard deleted from the source entirely.** Missed on the first attempt, and
   the reason is structural: the expectations are derived from the same file that
   was edited, so deleting the guard deleted the expectation. Fixed by giving the
   tool an **independent** truth — a hand-written `CRITICAL` list of the twelve
   boundaries that matter most, taken from `domain/roles.js` rather than from the
   routes. With that, the deleted guard is caught: same two findings.

The first cut of the extractor was also **wrong in the accusing direction**: it read
`atLeast(user.role, 'OWNER') ? featureLabels : null` — a route deciding how much of a
public answer to give — as a guard, and accused four routes that behave correctly
(`/api/settings`, `/api/dashboard`, `/api/tills/current`, `/api/branding/full`). A
guard is a demand that REFUSES, so a guard now has to be followed by a `throw`. Four
false accusations on the first run, zero on the last.

## Two tooling faults found on the way, both of which had been hiding results

- **`pkill -f "[n]ode server/app.js"` kills the shell running the command.** The
  shell's own command line contains the pattern, so the pattern matched the bash
  process and the command ended mid-way — which is why an edit "restored from a
  backup" in an earlier stage was silently never restored, and why several tool calls
  returned exit −1 after apparently finishing. Servers are now started with
  `echo $! > /tmp/srv.pid` and stopped with `kill "$(cat /tmp/srv.pid)"`.
- **Closing the jsdom window ends the run, not the page.** A screen still waiting on a
  request resumed into a torn-down document, `ui.h` had no `document`, and the throw
  landed outside jsdom and killed the probe — hiding the very screen it was about to
  report. The window is no longer closed, and late faults are recorded and reported
  instead of ending the process.

## Verified

- `npm run verify` → **292 tests, 292 pass**.
- Local, four seats, `--walk --deep-writes`: no problems; 54 guarded endpoints called
  per seat; 65 destinations walked.
- Staging, `admin` + owner: no problems.
- Both negative tests reproduce, and the clean run passes again afterwards.

---

# CHECKPOINT — Stage 8: THE SCHEMA AGAINST WHAT ACTUALLY USES IT

## Why this stage exists

The brief asks that *"all the capabilities possible from the schema are fully
utilised by all the forms of users"*. That cannot be answered by a test suite: a test
can only fail on code that exists. A table nothing writes is a capability a customer
cannot use, and nothing in this repository was looking for that.

## What was built

`tools/capability-audit.js` — for every table in the schema it asks: does any code
**create** it, **update** it, **read** it; is it **seeded** reference data; is it
**exposed** by an API route; and does the **frontend** ever call that route? The
scheme is derived from the statements, the route registrations and the frontend's own
API paths, so it cannot drift from any of them.

```
75 table(s) · 22 view(s) · 164 registered route(s) · 115 API path(s) written by the frontend
```

It runs in `npm run verify` and in CI (`npm run caps:audit`).

## The false finding it produced first, and what it taught

It reported **`audit_log` — "read but never created"**, about the one table whose
completeness is a security claim. The cause: the chained registers are appended
through a helper that takes the table name as an **argument** —
`appendChained(db, { table: 'audit_log', … })` — so a scan for INSERT statements
cannot see them. A named table in a helper call is a write site just as much as an
INSERT is, and the audit now counts it as one. A tool that accuses the audit trail of
not existing is worse than no tool.

## What it found: capabilities with no way in

Eight tables are declared, read by views and screens in some cases, and created by
nothing at all. Each is now written down in `tools/capability-baseline.json` with
**what it is for** and the decision on it, so the list is a to-do rather than a pile
of noise — and so that a **ninth**, arriving by accident in a future migration, fails
the build instead of quietly joining the pile.

| table | what it is for | decision |
|---|---|---|
| `branch_compliance_records` | SON/SONCAP, fire and weights-and-measures permits per branch; `v_compliance_expiry_alerts` already warns about them | **wire up** — the alerts are built and unreachable |
| `user_assignment_history` | who could see which branch and till, and when — "who could see the Minna till on 14 March?" | **wire up** — cheap, audit-adjacent |
| `pending_user_transfers` | a transfer the RECEIVING manager must accept, so a cashier cannot be moved to a branch nobody staffs | **wire up** — the accept/decline half is missing |
| `delivery_zones` | delivery area, fee and minimum order for the jobs `delivery_jobs` already records | **wire up** — fees are charged by hand today |
| `delivery_vehicles` | riders and vans, so a delivery can be assigned and its cost traced | later — worth it once zones exist |
| `stock_transfer_serials` | the serials that moved with a transfer, so a warranty claim traces back to the movement | **wire up** — serial tracking is in scope and transfers already move serial-tracked goods |
| `product_recalls` | which products and batches were recalled, and what happened to the stock | later — a whole flow, and it deserves its own stage |
| `data_cleanup_log` | what housekeeping purged, and when | **wire up** — `worker/src/housekeeping.js` already does the work and records nothing |

Two more findings are the sharpest, because the *reading* half already exists:

- **`product_price_overrides`** — read in **three** places (the sale engine's
  `loadPriceOverrides`, the product detail screen, and a route), and created by
  nothing. A shop can honour a branch-specific price and has no way to set one. This
  is squarely inside the accepted scope (wholesale price tiers, multi-branch pricing)
  and it is the first thing to build in the next stage.
- **`user_business_access`** — read by `server/middleware/auth.js` to work out which
  businesses a user may see, and written by nothing. Multi-business access exists as a
  concept and cannot be granted.

## Verified

- `npm run verify` → **292 tests, 292 pass**, with the capability audit inside the
  chain; `caps:audit` exits 0 against the baseline and would exit 1 on a new
  unreachable table.
- The audit's other sections are informational on purpose — "written and never read"
  (1: `variant_axes`, written by provisioning) and "18 routes no screen calls"
  (integrations, the sync engine and the admin-only endpoints) are reported without
  failing, because a finding is not always a defect.

---

# CHECKPOINT — Stage 9: THE BRANCH PRICE NOBODY COULD SET

## The capability

The Stage-8 audit found `product_price_overrides` as **"read but never created"** —
read in three places, created by nothing:

* `domain/pricing.js` documents its order of precedence as *manual → branch OVERRIDE →
  price list → product*, and `salesService.loadPriceOverrides()` has always loaded them;
* the product detail screen has always shown them;
* **nothing anywhere could make one.**

So an Ikeja shop could not price a kettle differently from its Aba shop, a shop could not
absorb its own delivery cost, and a wholesale counter could not carry a carton price that
differs from the piece price times twenty-four. It is squarely inside the accepted scope
(wholesale price tiers, multi-branch retail) and it was the sharpest finding in the audit
because half the feature already worked.

## What was built

**Two endpoints** (`server/routes/catalog.js`), following the house patterns exactly —
`canEditPrices` for authority, `resolveBranch` for the branch (body, query, pinned user,
scope and active-branch checks all in one place), `recordFromCtx` for the audit:

| | |
|---|---|
| `PUT /api/products/:id/price-override` | sets the whole pricing decision for one product in one branch — per piece, pack and carton |
| `DELETE /api/products/:id/price-override` | clears it, soft-deleted like every other mutable row, so "what did it used to be?" stays answerable |

Write-it-or-clear-it, with no third verb: a partial update would leave a `pack_price`
from a previous decision standing beside a new per-piece price, which is how a branch
quietly ends up selling packs below cost.

**A screen** (`public/js/views/products.js`): a **Branch prices** card on the product's
own page, listing every branch price with what it is worth against the catalogue, a form
that offers only the levels the product actually sells in (taken from its own unit
ladder), and a live warning when a price would lose money.

## The trap that shaped the SQL

```sql
UNIQUE (branch_id, product_id, variant_id)
```

SQLite treats NULLs as **distinct**, so this constraint does NOT stop two rows for the
same branch and product, both with a NULL variant. Two such rows make "which price
applies" depend on row order — exactly the ambiguity the override feature exists to
remove. The lookup therefore names the NULL case explicitly **and** reads the newest:

```sql
WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
  AND ((? IS NULL AND variant_id IS NULL) OR variant_id = ?)
ORDER BY updated_at DESC, rowid DESC LIMIT 1
```

The repository's own SQL audit is what forced the `ORDER BY`: it flagged both lookups as
*"db.first() on an unordered, unpinned query returns an arbitrary row"*. It was right —
and the ordering has a meaning, not just a silencing effect.

## A silent downgrade, found while picking a test fixture

The first version of the new integration test asked for `profileCode: 'WHOLESALE'`, got a
business with **no products at all**, and the first explanation that came to mind was
"the wholesale vertical has no starter catalogue". The truth was worse:

```js
function getProfile(code) {
  return PROFILES[key] || PROFILES[DEFAULT_PROFILE_CODE];   // ← for ANY string
}
```

Every unknown code became **GENERAL_RETAIL**, which made two guards dead code:

* `provisioningService`: `if (!getProfile(profileCode)) throw UNKNOWN_PROFILE`
* `catalog.js`: `if (!profile) throw UNKNOWN_PROFILE`

Neither could ever fire. The HTTP route was saved by an unrelated `oneOf` check, but
**everything that provisions through the service** — the seed tools, the scripts in
`tools/`, any integration — would have created a general-retail business with the wrong
categories, the wrong features and no catalogue, and reported success.

Fixed: `getProfile()` answers **null** for a code it does not have; the tolerant path is a
new, explicitly-named `getProfileOrDefault()` used only where a business's *stored* code
is being read. The service guard now fires and lists the verticals that exist:

> “WHOLESALE” is not a business vertical this system has. Choose one of: Electronics &
> Appliances (ELECTRONICS), Furniture & Home (FURNITURE), Wholesale & Retail General
> Merchandise (WHOLESALE_RETAIL), Building Materials & Hardware (BUILDING_MATERIALS),
> General Retail (GENERAL_RETAIL).

## A tooling fault that had been reporting false failures

`tools/lib/page-harness.js` `waitUntil()` called `probe()` **without awaiting it**. An
async predicate — the natural thing to write for "wait until the SERVER says the row is
gone" — returned a pending Promise, which is always truthy, so the wait "succeeded" on
its first tick. The new price probe reported that a cleared branch price was still on the
server **when the server had already said it was gone**. Fixed: the predicate is awaited.
Every tool that polls inherits the fix.

## Verified

- `npm run verify` → **300 tests, 300 pass** (was 292): +4 integration (the money path),
  +3 e2e (set/read-back/replace/clear over HTTP, a cashier refused with
  `PRICE_EDIT_NOT_ALLOWED`, and the unknown-vertical refusal), +1 integration for
  provisioning refusing a bad vertical and a good one arriving with its catalogue.
- **The money path, proved by the engine's own maths**: with an override of 1.1 × the
  catalogue, the Ikeja receipt totals the override and the **Aba receipt is untouched**;
  a carton override charges the carton price, not the piece price × 24; a second write
  replaces rather than stacks; a manual price still wins.
- `tools/frontend-price.js` (new): the whole feature through the real DOM — 6/6, from the
  card, through the form, to the server, and back off again.
- Four seats, 65 destinations walked by the smoke tool afterwards: no problems.

## Live on Cloudflare D1

The three environments were redeployed with Stage 9 in them, and the same probe run
against **staging** as the owner — the real Worker, the real D1 database:

```
✓ the product and its catalogue price      Anker 20000mAh Power Bank · ₦34,000 per unit
✓ the product page shows a Branch prices card
✓ the form asks which branch and what price   branch_id, default_selling_price, carton_price
✓ the card now shows the branch at the new price
✓ the server holds the branch price        Verify Branch · ₦37,400
✓ removing it puts the catalogue price back   ₦34,000 per unit again
```

The first live run **failed four assertions**, and the reason was worth recording: the
Worker was still running the pre-Stage-9 bundle. The route existed in git and not in the
deployment — the code was pushed but not yet shipped. That is the difference this
project's two-backend shape creates, and it is why the deploy step is part of every
stage rather than an afterthought.

# CHECKPOINT — Stage 10: THE ACCESS NOBODY COULD GRANT, AND A DEFECT CLASS
# THAT HAD BEEN QUIETLY KILLING SCREENS

Date: 2026-10-06 · Local: `npm run verify` → **305 tests, 305 pass, 0 fail** ·
Screen probe: **5/5** · Smoke: four seats, 12–25 destinations each, no problems.

## What Stage 10 adds

`user_business_access` was the last table the audit called *"read but never created"*.
It is the record that lets one person reach a business other than the one on their own
row — a group with two shops, a manager covering a second branch owner — and until now
nothing in the application could write one. The audit now reports **0** tables read but
never created.

- **`GET /api/users/:id/business-access`** — every business, with whether the person
  reaches it *by their own record*, *by a grant*, or not at all.
- **`POST`** — grant. Revives a previously revoked row rather than inserting a second
  one, because the table carries `UNIQUE (user_id, business_id)` and a revocation is a
  decision somebody can still read.
- **`DELETE …/:businessId`** — withdraw, soft-deleted with `revoked_at` stamped.

**ADMIN only, deliberately.** A grant is a cross-tenant act: an owner is already scoped
to every business in their deployment by role, so letting an owner grant reach into a
business would let one legal entity hand out access to another. The two e2e refusals —
owner and manager both get 403 on grant *and* on review — are there to keep that rule
from being relaxed for convenience later.

**A grant widens what a person can SEE, never what they may DO.** The e2e suite holds
that line: after being granted a second business, the manager sees it **on the existing
token without re-logging in** (scope is re-resolved per request, not held in the token)
and still receives 403 on `PUT /api/settings`. A grant never widens the ROLE, and it
never unpins a cashier.

## The defect class

Building the screen for the above surfaced the mistake, and then found its siblings.

`SR.api.post(path, payload)` takes the payload as the **second** argument — the option
object is for the lower-level `SR.api.request`. Seven screens were calling it as
`SR.api.post(path, { body: { … } })`. That sends the JSON `{"body":{"id":7}}`; the server
reads `body.id`, finds nothing, and answers *"id is required"* — a message about the
field, never about the mistake. `Object.assign` is unguarded here, so nothing complains
on the way in. **Every one of those screens had never worked.**

Proved over HTTP as `blessing`, whose PIN is known:

| what the screen sent | server said |
|---|---|
| `{ body: { current_pin: … } }` | 400 *"Current PIN is required."* |
| `{ current_pin: … }` | 400 *PIN_WEAK* — the real validation, reached |

**Seventeen call sites**, in the end: change your own PIN, add/edit a branch, edit a
business, mark a WHT entry remitted, add a ledger account, post a manual journal, set a
sales target, resolve a sync conflict (both decisions), **open a till, close a till, post
a safe entry**, till review, reset a PIN, sign a user out everywhere, anchor the audit
chain, and create a user. Ten were found by grep; the other nine were multi-line calls
that the grep could not see, and were found only when the rule itself was made a test.

`test/e2e/frontend-routes.test.js` now carries the rule as a **small parser**, not a
regex: it walks each `SR.api.post|put|patch` call to its matching close paren, splits the
arguments at the top-level comma, and fails the build if the second argument opens with
`{ body:`. The first attempt used a file-spanning regex and cheerfully reported eight
perfectly good multi-line calls as offenders — which is how the real nine were noticed.

## From the screen

`tools/frontend-access.js` drives the real DOM in jsdom: open a person on the Staff
screen, read the businesses they can reach, tick one, and then hold the SERVER to the
result — then untick it and hold the server to that too.

The probe's own first attempt was wrong in a way worth keeping in the record: after the
tick the screen re-renders from the server, so a snapshot taken a moment early sees the
**pre-reload** boxes, whose first enabled one is a *different, unchecked* business. The
probe unticked that one, the server correctly answered "no grant to remove", and the
probe reported the withdrawal as broken while the tick's own grant sat there untouched.
Fixed by naming the business and holding the probe to that one — and the leftover grant
the earlier run left behind was withdrawn, so the demo deployment is back to one
business reached by own record.

```
✓ a person to grant to                          Aisha Bello · MANAGER · Ridge Furniture Palace
✓ opening a person shows the businesses         Reaching 1 of 4…
✓ the section lists businesses with switches    4 business(es), 1 locked, 3 switchable
✓ ticking a business grants it, and the server holds it    Ridge Electronics Ltd · 0 → 1
✓ unticking it withdraws the grant on the server           Ridge Electronics Ltd · back to 0
```

A deployment with only one business **skips** the last two with a reason rather than
passing quietly — a skip is not a pass.

## Where this leaves the audit

- Tables read but never created: **0**.
- Tables created but never read: 1.
- Wire-ups still owed: `branch_compliance_records` (**next** — the view
  `v_compliance_expiry_alerts` is built and has no way to be reached), then
  `user_assignment_history`, `pending_user_transfers`, `delivery_zones`,
  `stock_transfer_serials`, `data_cleanup_log`; later `delivery_vehicles`,
  `product_recalls`.
- Still outstanding from earlier stages: the live staging offline proof
  (`tools/frontend-offline.js`) and `public/offline.html`.

## The rule had one case, and the scope had three

`buildScope` (`domain/access.js`) gives every business in the deployment to three
different kinds of user:

```js
const allBusinesses = isAdminVendor || role === ROLES.OWNER || pinnedBusinessId === null;
```

The endpoint refused a grant only for an **ADMIN**. So the screen offered an **owner** —
who already reaches every business by role — three live switches that could not change
what they could see by anything at all, and offered the same to anyone with **no business
on their row**, where `pinnedBusinessId === null` means nothing is pinned and therefore
nothing is excluded.

That is the same defect as the payload one above, one layer up: a control that looks
meaningful and cannot take effect. Fixed at the source, once — the route now answers with
*why* a person already reaches everything (`reachesEverythingBy`), and the screen prints
that reason instead of inferring one from the role:

| the person | what the screen says | the server |
|---|---|---|
| administrator | "…reaches every business here by virtue of that role" | `409 ALREADY_REACHES_EVERY_BUSINESS` |
| owner | "…is an owner, and an owner reaches every business in this deployment" | `409 ALREADY_REACHES_EVERY_BUSINESS` |
| no business pinned | "…is not tied to any one business, so every business already reaches them" | `409 ALREADY_REACHES_EVERY_BUSINESS` |
| a manager on one business | "Reaching 1 of 4…" with the switches live | the grant, and the withdrawal |

The e2e suite now pins all of it, including the case the rule must **not** swallow — a
manager is reported as *not* reaching everything, so the feature keeps working.

## The probe had the defect it was built to catch

The first live run of `tools/frontend-access.js` created its second business as
`api('POST', '/api/businesses', { body: { … } })` and the deployment answered
`400 {"error":"name is required.","code":"MISSING_FIELD"}` — the tool written to catch the
`{body:…}` class, doing it.

The screens are a fixed list of names, so the browser check is a list. Tools each bring
their own helper, so the new test **reads the helpers out of the file**: any function
whose body JSON-stringifies a parameter called `body` takes the payload as that parameter,
and a call wrapping the payload in a `body` key is a lie. It was proved to fire — the
wrapper reintroduced in a copy of the probe is reported at `tools/frontend-access.js:80`,
with the source line — before being trusted to say nothing.

## The deploy script invented a database

Deploying `--env=prod` — a natural thing to type when the block is called
`[env.production]` — produced this:

```
✓ created: c9824b2e-213a-47ca-921c-9faee989dfdc      ← a database nobody wanted
✓ database_id set for env "prod" in worker/wrangler.toml
✓ other environments untouched: … production → stockridge (32aa519c…)
Deployment failed: wrangler d1 migrations apply stockridge-prod …
```

Two faults, both silent:

1. **The database name was derived, not read.** `stockridge-${ENV_NAME}` is right for
   staging and sample and wrong for production, whose database is called `stockridge`
   because it was created first. So the script looked for `stockridge-production`, found
   none, **created** one — and then rewrote the *production* binding to point at the empty
   database while the real one sat untouched. The file says which database an environment
   uses; that is now the only place the name comes from.
2. **The no-op reported success.** `writeDatabaseId` refuses in a comment to be "a silent
   no-op that reports success", and then was one: with no matching section it skipped the
   write and printed `✓ database_id set` anyway. It throws now.

An unknown environment name is refused before anything is created, and the refusal prints
the environments the file actually declares.

**Recovery, recorded because it matters to anyone reading the account:** `worker/wrangler.toml`
was restored with `git checkout --`, the phantom database was deleted through the API, and
the account is back to three databases — `stockridge`, `stockridge-staging`,
`stockridge-sample`. Production was then deployed as `--env=production`, and prod answered
`admin` / `1234`, `1 user (admin:ADMIN)`, `0 businesses` — the handover state — with the
Stage-10 route live (`GET /api/users/:id/business-access` → 200).

## Live on Cloudflare D1 — Stage 10

Three environments redeployed, **6/6 readiness each** (schema, migrations, administrator,
PIN hashing, sign-in lookup): `sample` and `production` awaiting their first business,
`staging` ready with a business trading.

Staging then proved the whole feature across the real Worker and the real database, as
`admin` / `1234`, against a person created through the application's own staff flow:

```
✓ a second business to grant (created for this probe)   Verification Furniture Co
✓ a person to grant to                                  Verification Staff · STAFF
✓ opening a person shows the businesses they can reach   Reaching 1 of 2…
✓ the section lists businesses with switches            2 businesses, 1 locked, 1 switchable
✓ ticking a business grants it, and the server holds it  Verification Furniture Co · 0 → 1
✓ unticking it withdraws the grant on the server         Verification Furniture Co · back to 0
```

# CHECKPOINT — Stage 11: THE FIRST BASELINE WIRE-UP, AND FOUR THINGS IT CAUGHT

Date: 2026-10-06 · Local: `npm run verify` → **322 tests, 322 pass, 0 fail** ·
Screen probe: **8/8** · Smoke: four seats, no problems · Capability audit:
**0 tables read but never created**, 0 routes served that no screen calls.

## `branch_compliance_records` — the licence register, and the alerts nobody raised

The table has existed since the first migration. Its view, `v_compliance_expiry_alerts`,
has existed just as long. **Nothing had ever written a row to the one, and nothing had
ever read the other** — so a shop could not record that its SONCAP dealer registration
expires in March, and the application could not warn anybody when it did. A Nigerian
business can be fined, sealed or held at the port over exactly this paperwork.

What now exists:

| | |
|---|---|
| `GET /compliance/records` | the register, filtered by branch, type and status |
| `POST /compliance/records` · `PUT` · `DELETE` | record, correct, remove — MANAGER+, branch-scoped, audited, soft-deleted |
| `GET /compliance/alerts` | **reads `v_compliance_expiry_alerts`**, windowed by the owner's setting |
| `GET /compliance/checklist` | what this branch's **vertical** expects it to hold, against what it holds |
| `POST /compliance/notify` | raises the notifications, idempotently |
| the **daily cron** | runs the same statement, so an alert reaches a manager who never opens the screen |

`profile.complianceFields` had been documentation since the verticals were written — the
list that says an electronics dealer is offered SONCAP and NCC type approval, a furniture
shop forestry and CITES, a building-materials yard a quarry permit. It is now the spine of
the Checklist tab, which can say a permit is **MISSING** rather than merely absent from an
empty list.

Nothing here blocks trading. A record of a type the vertical does not list is kept and
labelled as unrecognised — the schema is explicit that an unusual permit must never stop a
client going live. The only refusal is bookkeeping that has no reading: two live records of
one type on one branch.

## Four defects it caught on the way

**1. `resolveBranch` silently swapped a named branch for the caller's own.** A branch-pinned
manager who posted a licence for another branch had the request quietly rewritten to their
own branch, and got a 201 naming the substituted shop. That is how stock or cash gets posted
against the wrong branch by a client that asked for the right one. A named branch that is not
yours is now refused (`403 BRANCH_SCOPE_VIOLATION`); the pin still answers when nothing is
named.

**2. `inScope(scope, branchRow)` answered on the wrong question.** It reads `row.branch_id`,
and a BRANCH identifies itself as `row.id` — so passing a branch skipped the branch check
entirely and answered on the business alone. It let a manager **edit and delete another
branch's licence records**. Fixed with a purpose-built `inBranchScope(scope, branch)`, and
the trap is now documented on `inScope` itself, where the next reader will meet it.

**3. An owner could not see a single notification.** The notifications list filtered
broadcasts by the caller's raw `user.branch_id`, with the literal string `'__none__'` for
anybody who has none — which is every owner and every administrator. An owner matched
neither half of the clause and got an empty list, while a branch manager saw their own shop
and nothing else. Nobody noticed because **nothing in the application produced a
notification at all**; the bell was empty for two reasons at once. Stage 11 gave the table
its first producer, and the first licence alert was invisible to the one person whose job it
is to renew licences. The list now filters by the caller's resolved SCOPE, and both
directions are asserted: the owner sees it, and the other branch's manager does not.

**4. One API-call reader became three, and each was wrong in its own way.** The extractor
that compares frontend calls against the server's route table stopped at the first backtick,
so a template literal containing another template was read as a truncated path:

```js
SR.api.get(`/api/compliance/alerts${branchId ? `?branch_id=…` : ''}`)
    →  '/api/compliance/alerts${branchId '   →  "a route the server does not have"
```

It was fixed in one copy, and a **second** copy (a different regex, the same mistake) failed
the next run; then a **third** copy inside `capability-audit.js` listed `GET
/api/compliance/alerts` as a route no screen calls — a live route reported as dead. There is
now ONE reader, `tools/lib/api-calls.js`, used by both contract tests and by the audit, and
it is a scanner rather than a character class: nested templates and ternaries, whole-segment
holes as `*`, glued holes dropped, `?query` stripped after holes are resolved, `SR.api.del`
as DELETE. It was proved to fire — a call to a route that does not exist is reported at the
exact line by BOTH tests — before being trusted to stay silent.

## And a fifth thing, which is the next stage

Building the settings control for the alert window turned up this:

```
settings controls on the screen : 30
columns that exist              : 49
CONTROLS WITH NO COLUMN         : 15
```

Fifteen controls on the Settings screen write keys that **do not exist in
`client_settings`** — so they cannot save, and the server ignores them. Four are the right
capability under the wrong name:

| the screen writes | the column is | 
|---|---|
| `low_stock_alerts` | `low_stock_alert_enabled` |
| `require_serial_capture` | `serial_tracking_enabled` |
| `receipt_footer` | `receipt_footer_text` |
| `staff_can_discount` (a flag) | `staff_discount_max_pct` (a percentage — 0 means none) |

The other eleven have no column anywhere: `prices_include_vat`, `expiry_alerts`,
`block_negative_stock`, `credit_limit_enforced`, `default_credit_limit`,
`debtor_reminder_days`, `require_till_open`, `till_variance_alert`,
`require_safe_banking`, `banking_reminder_days`, `receipt_show_vat`. Two of those describe
behaviour that is **unconditional in the code** — credit limits are always enforced
(`salesService` checks `canSellOnCredit` against the customer's limit) and a till must
always be open to sell (`409 TILL_NOT_OPEN`, unless the sale is back-dated) — so a switch
for them is a lie in the other direction: it promises a choice that does not exist.

**That is Stage 12**: every control on Settings either writes a real column or says out loud
what is actually true, with a build-failing rule that a settings key not in
`DEFAULT_SETTINGS` cannot ship. Exactly the `{body:…}` class from Stage 10, one layer up.

## Also fixed, because the suite had become a liar

`npm run test` failed five e2e tests at **05:04** with *"That sale is stamped 296 minutes in
the future, beyond the 10-minute tolerance for device clock drift"*. Nothing to do with the
work: six tests stamped sales at a **fixed hour of today** —

```js
sold_at: `${watToday()} 10:00:00`      // sensible-looking determinism, and a landmine
```

— which is in the future for any run before 10:00 West Africa Time, and CI runs at whatever
hour it runs. Two more sent `new Date().toISOString()` (UTC) where the schema stores WAT,
which is the previous day between 23:00 and midnight UTC. All six now use `watNow()`, and
`test/unit/test-hygiene.test.js` fails the build if a test stamps a sale at a fixed hour of
today or in UTC. Proved to fire, and it reported two false positives on its own first run
(a field after the timestamp, and its own source text), which are fixed.

## Where this leaves the audit

- Tables read but never created: **0**
- Tables created but never read: 1
- Tables that exist and nothing creates, not even a seed: **7**
- Routes no frontend code asks for: 19 (unchanged, now the true number)
- Wire-ups still owed: `user_assignment_history`, `pending_user_transfers`,
  `delivery_zones`, `stock_transfer_serials`, `data_cleanup_log`; later
  `delivery_vehicles`, `product_recalls`.
- Still outstanding from earlier stages: the live staging offline proof
  (`tools/frontend-offline.js`) and `public/offline.html`. The notifications bell: the
  routes and the producer now exist and no screen shows a bell.

# CHECKPOINT — Stage 11b: A READ IS NOT NARROWED BY A GUESS

Date: 2026-10-06 · Local: `npm run verify` → **330 tests, 330 pass, 0 fail** ·
New test: `test/integration/read-scope.test.js` **7/7** · Live on all three
deployments · Staging compliance probe **8/8** after the fix.

## What the live probe found that the tests could not

The compliance screen worked locally and failed on staging, in the worst possible
way: **the write succeeded and the read did not see it.** A licence was recorded
from the screen, the server answered 201 with the record's id, and the Register
tab came back empty. Worse, trying again was refused:

```
Verification Showroom already has a live CAC record (PROBE-718734).
Edit that one, or remove it first if this replaces it.
```

The record existed, could not be listed, and could not be re-entered. Nothing was
broken; everything was *narrowed* — and the two halves of the request disagreed
about what business they were talking about:

* the **write** took its business from the branch it was given — a fact;
* the **read** named nothing, so `resolveBusiness` answered with the deployment's
  primary business, and when that was unset, with **the oldest live business**.

Staging has two (`Verification Furniture Co`, created 05 Oct 20:24, and
`Verification electronics-muvifjtk`, created 05 Oct 17:14). The probe recorded
against the furniture showroom. The guess picked the electronics business — the
older one — so every unfiltered read came back empty and every write was blocked
by a guard that was reading the same table the list was hiding.

```
GET /api/compliance/records                       → 0 rows   ← the guess
GET /api/compliance/records?branch_id=<showroom>  → 2 rows   ← the fact
```

## The rule, and where it now lives

**A read is narrowed by what the request NAMED, or by the caller's scope. Never by
a guess.** `resolveBusiness` grew `{ required: false }` and two helpers:

| | |
|---|---|
| `readBusinessFilter(db, ctx, {column, alias, allowNull})` | a SQL clause, ready to splice |
| `readBusinessId(db, ctx, {branch})` | the id, or `null` meaning NO NARROWING |

`null` is not "no business" — it is "this caller reaches every business and named
none", which is precisely when narrowing is a lie. Two more rules fell out of it:

* **the pin answers a WRITE, not a READ.** Every OWNER has both `allBusinesses` and
  a `business_id`, so letting the pin narrow a read hid the other businesses they
  demonstrably reach. A write still takes the pin (a new row must belong to
  somebody).
* **a POST that carries its own payload has named its business.** `resolveBusiness`
  now reads `business_id` out of the body as `resolveBranch` already read
  `branch_id`; the client's own sync pull sends `branch_id` in the body for exactly
  that reason.

## Converted: 21 reads across 7 files

| file | reads |
|---|---|
| `accounting.js` | chart of accounts, journal, VAT return, WHT return |
| `reports.js` | sales, inventory movement, movers, top customers, commission, targets, export (8 queries) |
| `customers.js` | customer classes |
| `finance.js` | creditor book |
| `sync.js` | the pull that seeds a device |
| `compliance.js` | the register, the checklist |

`catalog.js` already did this correctly — it filters by the query parameter and by
`scope`, never by a resolved business — and was left alone. `dashboard.js` had
worked it out for itself (`isOwnerView ? null : await resolveBusiness(...)`) and
was the only place that had.

**The VAT return needed more than a filter.** It reads `business.vat_registered`
to decide whether an input-VAT credit exists, so a caller reporting across several
businesses gets the credit if *any* of them is registered, and the response says
which rule produced the answer.

## Proved both ways

`test/integration/read-scope.test.js` builds one deployment with two businesses —
the newer one deliberately furniture, because the guess falls back to the OLDEST —
and drives real HTTP:

* the chart of accounts, the VAT summary, the sales report, the CSV export, the
  customer classes, the creditor book and the sync pull each carry **both**
  businesses;
* naming one business still narrows, in both directions, on every one of them;
* the system rows (`business_id IS NULL`) stay visible to a narrowed caller;
* a branch-pinned manager still reaches their own shop and nothing else.

**Negative control:** restoring the old guess in `resolveBusiness` failed **5 of the
6** subtests and the compliance regression; the branch-pin test still passed, which
is the point — the fix did not open anything up. 330/330 with the guess removed.

## Live

All three deployments redeployed (sample / staging / production, `admin`/`1234`).
On staging, after the fix: the screen probe is **8/8**, the register reads back,
both strays from the failed runs are cleaned up, and the deployment carries **0
compliance records, 0 alerts, 0 notifications** — it looks untouched, which is what
a handover should look like.

Two probe defects fixed on the way: it now **sweeps its own strays** (`PROBE-\d{6}`
left over from a run that died part-way) before it starts, and it **marks its own
alerts read** so a demonstration licence never sits in a real bell.

## Still owed

Settings controls (15 of 30 write keys that are not columns) · the remaining
wire-ups (`user_assignment_history`, `pending_user_transfers`, `delivery_zones`,
`stock_transfer_serials`, `data_cleanup_log`) · the notifications bell on screen
(the routes and the producer now exist; no screen shows a bell) ·
`public/offline.html` and the live staging offline proof.

# CHECKPOINT — Stage 12: THE SETTINGS SCREEN, WHICH HAD NEVER SAVED ANYTHING

Date: 2026-10-06 · Local: `npm run verify` → **348 tests, 348 pass, 0 fail** ·
Live on all three deployments · Settings probe **5/5** on staging · Compliance probe
**8/8** on staging.

## Fifteen controls that were never on the page

Fifteen of the thirty controls on Settings named keys that do not exist in
`client_settings` — `low_stock_alerts` where the column is `low_stock_alert_enabled`,
`receipt_footer` where it is `receipt_footer_text`, `require_serial_capture` where
the flag is the whole module. The renderer skips a key the deployment does not
have:

```js
if (!(item.key in s)) continue;     // "a setting this deployment does not have"
```

so those controls did not sit there failing to save. **They never drew.** An owner
who wanted the stock warning switched on was looking at a page that did not have
the switch on it and said nothing about why.

The other half of the same defect: **twenty-nine writable columns had no control at
all.** How many days a customer has to pay, what deposit a layaway needs, how long
an instalment plan may run, whether managers may void a sale, whether the shop does
deliveries — all settable by us and not by the merchant.

The screen is now **8 groups, 44 controls, 8 stated facts**, and every one of them
is backed by a column the server reads.

## The switches that lied

Some of the old controls described behaviour that has no alternative. The app
always treats quoted prices as VAT-inclusive (the sales table's own CHECK enforces
`subtotal - discount + delivery = total`), always requires an open till to sell,
always refuses credit above a customer's limit, always assesses the customer class
and the customer. A switch for those promises a choice that does not exist, and an
owner who turns it off believes something changed.

They are `type: 'fact'` now — same grid, same size — and they say what the system
does instead:

> **Why there is no credit-limit switch.** A sale above a customer's credit limit is
> always refused, and the switch on this page decides whether a MANAGER may override
> that refusal. There is no way to turn the limit off entirely, because a limit that
> can be ignored is not a limit.

> **Where the default credit limit lives.** Not here. A credit limit belongs to a
> customer CLASS — Walk-in, Trade, Wholesale — and its default is set on the
> Customer classes screen, because a wholesaler and a walk-in customer should not
> share one number.

## Three settings the code read and nobody could set

```
domain/credit.js:198       Number(settings.credit_grace_days) || 0
domain/instalments.js:291  Number(settings.instalment_default_after_days) || 60
domain/instalments.js:292  Number(settings.instalment_default_after_missed) || 3
```

Both are handed real settings by their routes (`customers.js:346`,
`afterSales.js:1380`), and none of the three had a column. The behaviour worked, at
0 days' grace and 60 days of arrears and 3 missed instalments, and **how many days
late a customer may be before the counter warns is not a number to guess at for a
merchant** — it is exactly the judgement one Nigerian trader makes differently from
the next.

`schema/migrations/0003` adds the three columns, with the defaults the code was
already falling back on, so applying it changes nothing until somebody chooses.

## And the trap underneath: a flag and a number look identical

The settings route decided a value's type by looking at its default —
`[0, 1].includes(def)` meant "this is a boolean". True of a flag; **false of any
number whose sensible default is zero**, and there are two: `credit_grace_days`
(days) and `staff_credit_max` (naira). So `credit_grace_days: 30` went to
`boolField`, which does not recognise `30` as a boolean and returned the fallback:

```
PUT /api/settings {"credit_grace_days": 30}   →  200 "1 setting(s) changed"
GET /api/settings                              →  credit_grace_days: 0
```

Saved as zero, reported as success. The flags are now **named** in
`FLAG_SETTINGS` (`domain/planLimits.js`), and the unit test fails if a setting whose
default is 0 or 1 is neither a flag nor a documented number.

## The Save button had never worked

The probe that types a value into the page and reads it back over HTTP failed the
first time it ran, for a reason no API test could have found:

```
That is not a setting: body. Nothing was changed.
```

`SR.api.put(path, body, opts)` takes the payload as its **second argument**, and
the screen sent `{ body }` — an object whose only key is `body`. Saving ANY setting
on that screen has therefore never worked. The Stage-10 sweep for this exact defect
looked for `{ body:` **with a colon**, and this is the shorthand form, which is why
it survived a sweep that was specifically hunting it. Two sites existed: the
Settings Save, and **editing a user** (`views/users.js:442`). Both fixed, and the
guard now matches the shorthand.

The screen's own error message is what made this findable in one run. Before this
stage the server **silently ignored an unknown key** and answered "Nothing to
change" — so a typo'd payload and a correct one with no changes were
indistinguishable. A key that is not a setting is now `400 UNKNOWN_SETTING`, naming
the key, and nothing in that request is applied.

## And the date "overdue" was measured from

Adding `credit_grace_days` exposed the next thing: `debtor_ledger` had no
`due_date`. Every ageing reader falls back to `created_at` —

```js
domain/credit.js:overdueWarning   e.due_date || e.created_at
```

— so "overdue" silently meant "sold more than N days ago" and the grace period meant
something different for every customer class. `sales.due_date` has been computed
from the customer's terms since the first migration; the ledger simply never carried
it across. Migration `0004` adds the column, populates it for existing credit sales
from the sale each charge names, and the sale path now writes it. Backfilled exactly
on the demo database: **63 of 63 rows**.

Two more defects on the same read path, both of which made the new setting behave
differently in different views: the debtors list dropped `settings` entirely (so the
owner's grace was applied on one customer's page and ignored on the list), and both
`overdueWarning` and `defaultTrigger` defaulted "today" to a **UTC** date — the
previous day between 23:00 and midnight in Lagos. Both now use WAT.

## The rule, so it cannot come back

`test/unit/settings-controls.test.js` reads the three lists — the **columns** (from
the migration SQL), the **whitelist** (`DEFAULT_SETTINGS`) and the **controls** (from
the screen source) — and fails when they disagree:

* every control writes a column, through a whitelist that contains it
* no two controls claim one setting
* a writable setting is either on the screen or excluded with a stated reason
* every column the API can write is in the whitelist (this caught
  `receipt_footer_text`, a live column the settings route had never allowed)
* a number's declared range agrees with its default
* **no route reads a settings key that does not exist** — comments are stripped
  first, because a comment explaining why a dead guard was removed is not a read of
  it
* a flag is a flag and a number is a number

`test/integration/settings.test.js` then proves the round trip and the *behaviour*:
a debtor fifteen days past their due date raises the warning at a grace of 0, does
not at a grace of 30, and the debtors list and the customer page agree. A value that
is stored and never read is the same lie in a different place.

`tools/frontend-settings.js` proves it through the DOM: it asserts every declared
control has an input **by name**, that nothing on the page says a control is
unavailable, that the seven formerly-invisible controls are specifically present,
and that a value typed into the page reaches the server — then puts it back, so a
demo deployment's credit policy is not left as the probe's opinion.

## Live

All three deployments redeployed, migrations `0003` and `0004` applied to every D1
database. Staging: settings probe **5/5** (typed 7, read back 7, restored to 0),
compliance probe **8/8**, and the deployment left as it was found — 0 compliance
records, 0 unread notifications, settings at their defaults.

## Still owed

The remaining baseline wire-ups: `user_assignment_history`, `pending_user_transfers`,
`delivery_zones`, `stock_transfer_serials`, `data_cleanup_log`; then
`delivery_vehicles`, `product_recalls`. The notifications bell still has routes, a
producer and no screen. `public/offline.html` and the live staging offline proof.
A Features screen for the plan usage the audit reports (`planUsage`, `/api/settings`
returns it) — the module flags are on Settings now, the plan limits are only API.

# PLAN — Stage T: PHARMARIDGE'S TEST FORMS, REPLICATED IN STAGES

PharmaRidge shipped **twelve forms of test**, and reading the dump (`uploads/0.txt`)
is the fastest way to see what a production PWA in this market actually needs
audited. They are forms, not files: each exists because a class of defect is
invisible to the others.

| form | PharmaRidge | why it exists |
|---|---|---|
| **Domain audits** | `audit.money.js`, `audit.wht.js`, `audit.inventory.js`, `audit.customers.js`, `audit.sync.js`, `audit.workflows.js`, `audit.exports.js`, `audit.expiry.js` | one script per domain, run against a **live server** via `WORKER_BASE` — not against services |
| **Two-way probes** | `probe-change-owed`, `probe-cashfloor`, `probe-safe-till`, `probe-reversals`, `probe-receiving`, `probe-unit-alignment` | act, then **read the resulting figure back** over HTTP. A 200 is not evidence |
| **Fresh-state runners** | `run-core-live.sh`, `run-full-domain-audit.sh` | `fresh_database()` + `start_server()` + `run_one X` per script, so no script's fixture becomes another's false failure; retry once on transient infra |
| **Role-pair matrix** | `audit.adminowner`, `ownermanager`, `managerstaff`, `staffstaff`, `vendorseat`, `branchscope`, `rolelabels`, `rolelifecycle`, `promotionauthority` | **a file per PAIR of roles.** "Every role audited alone; nobody walked a transition BETWEEN them" |
| **Three-month simulation** | `simulate-three-months.js` + `audit.three-month-simulation.js` | build a 90-day history, then audit that the **correlated records** agree — ageing, expiry, retention, arrears. Needs time; no unit test has it |
| **Traps register** | 149 numbered entries | every defect found, and the rule that prevents it. The cheapest institutional memory there is |
| **Docs audit** | `audit.docs.js` | docs are checked against the code, so a doc cannot drift into fiction |
| **HTTP contract** | `audit.http.js` | the **real** response headers and status codes, not the config file that claims them |
| **Concurrency** | `audit.concurrent-pos-sales.js`, `audit.single-session.js` | two writers on one row/batch |
| **Platform limits** | `audit.d1limits.js` | D1 bindings, rows, statement size — fail locally, not in production |
| **Go-live gate** | `audit.golive.js` | "does any endpoint exist with no UI at all"; readiness state |
| **Suite self-check** | restored-artefact integrity check | every test file parses, every entry point exists, `package.json` is wired |

## The stages

* **T1 — the harness, the runner and the self-check.** `test/audit/lib/` (report
  format, actors, two-way helpers, fresh live server), `test/run-audits.sh`
  (fresh state per audit), `test/audit/suite.js` (the self-check form), and the
  first domain audit to prove all of it: `audit.http.js`.
* **T2 — money and tax, two ways.** `audit.money.js` (sale → split payment →
  change owed → till → cash floor → safe → banking → void → ledger → trial
  balance) and `audit.wht.js` (VAT-inclusive extraction, WHT rates as data, the
  returns). Act, then read the figure back.
* **T3 — the role matrix.** A file per pair (ADMIN×OWNER, OWNER×MANAGER,
  MANAGER×STAFF, STAFF×STAFF, vendor seat×OWNER, branch scope, role labels) plus
  the lifecycle: what happens to a user's access when their role CHANGES.
* **T4 — sync, idempotency, concurrency, platform limits.** Stale replay,
  duplicate push, LWW conflict capture, two sales on one batch, D1 binding and
  statement limits, a soak.
* **T5 — the three-month simulation.** A 90-day operating history built through
  the API, then audited for internal consistency: ageing buckets against the
  ledger, expiry alerts against dates, instalment arrears against the schedule,
  warranty expiries, retention windows.
* **T6 — docs, playbook, traps and the go-live gate.** `audit.docs.js`,
  `docs/TESTING-PLAYBOOK.md`, `docs/TRAPS.md` (built from the defects this project
  has already found), and `audit.golive.js` folding the capability audit and the
  deployment readiness checks into one gate.

Each stage: built, proved by a negative control, run against **live staging**,
checkpointed here, pushed.

---

# CHECKPOINT — Stage T1: the audit harness, the runner and the self-check

*Appended after Stage 12. Everything below is deployed and verified against the
three live environments, not just locally.*

## What T1 built

| File | What it is |
| --- | --- |
| `test/audit/lib/harness.js` | `Audit` + `runAudit`: the report format, `pass/fail/skip/check/checkAsync/twoWay/refusal/capture/captureAsync/note/report`. One way to report, so the runner can run anything in `test/audit/` without knowing what it does |
| `test/audit/lib/deployment.js` | A **real deployment per audit**: migrates a fresh tmp database, provisions it through `provisioningService`, spawns `server/app.js` as a child process on its own port, waits for `/api/health`, signs in actors, and cleans up. `Actor.get/post/put/del/call`, `Deployment.login/seat/describe/provision/retireUser/retireBusiness/close` |
| `test/audit/audit.http.js` | The first audit: the HTTP surface, the PWA, UTF-8, response shapes, and the branch scope seen from a pinned manager's seat. **35 checks** |
| `test/run-audits.sh` | The runner. One audit per process, fresh state each, retry once on a lost port, summary, exit code |
| `test/audit/suite.js` | The self-check: every file in `test/audit/` accounted for, every audit parses, every audit uses the harness, `package.json` and the runner are wired to each other, the live-target variables are either set properly or not set at all |
| `public/offline.html` | **NEW — the page a shop sees when the network is gone** (see the fix below) |

`npm run test:audits` → the runner. `npm run test:audits:staging` → the same
audits against live staging.

## The one real product gap T1 found, and it is now closed

**The service worker named no offline fallback page at all.** `public/offline.html`
had never existed; `public/sw.js` built its fallback as an inline HTML string inside
the navigation handler, which meant the page a shopkeeper sees at the counter with a
customer waiting was written in a different file from every other page in the app,
could not be styled, and no test could read it.

Fixed properly:

* `public/offline.html` — a real page, one file, own inline styles, no network
  requests at all (it renders when nothing else will). It answers the three questions
  the person at that counter actually has: *is my sale safe* (yes, it is queued on
  this device), *can I keep selling* (yes), *what do I have to do* (nothing — the
  queue pushes itself). It counts the outbox in IndexedDB and says how many items are
  waiting, and it retries `/api/health` itself so the page turns into the app again
  the moment the network returns.
* `public/sw.js` — `'/offline.html'` added to `SHELL` (precached), served as the
  navigation fallback **after** the app shell (a cached shell is the better answer;
  the fallback is for a device that has never reached the server or a cleared cache),
  and `BUILD` bumped `ridge-1` → `ridge-2` so every device throws the old cache away.
* **Deployed to all three environments and verified live** — the audit reads `/sw.js`
  off the live worker, asserts it precaches the page it names, then fetches that page
  and asserts it is a page, says it is offline, and shows no `undefined`, `NaN`,
  `null` or un-substituted placeholder **to the reader** (comments, styles and scripts
  stripped — the first version of this check searched raw bytes for the word
  "undefined" and went red on a comment that explained the check).

## The one real product defect T1 found, and it is now closed

**An owner whose row carries a branch could read every branch and write to none.**

`resolveBranch` refused any request naming a branch other than the caller's own
`branch_id` — before consulting what the caller could actually reach. For a
branch-pinned MANAGER that is exactly right and is the fix that stopped a compliance
record being posted into the wrong shop. For an OWNER (whose scope is *all* branches,
because scope treats an owner as reaching everything) it produced a live
inconsistency: staging's owner seat carries a branch, so that account could open every
branch's stock, sales and reports and was then refused with *"You can only work in the
branch you are assigned to"* the moment it tried to transfer from one.

* Fixed in `server/lib/respond.js`: the pin refuses only what the scope cannot reach
  (`reaches()`), and a named branch the caller may reach is honoured rather than
  silently replaced by the pin, which remains the answer when nothing is named.
* `npm run verify` **348/348**, `read-scope` 7/7, `compliance` 15/15 after the change.
* Deployed to all three environments.
* **Proved live**: `audit.http.js` now performs the write — as the owner, create a
  STAFF user at a *different* branch — on staging in write mode. It was red before the
  deploy (`403 BRANCH_SCOPE_VIOLATION`) and green after.

## The difference that is NOT a defect, recorded so nobody "fixes" it

Cloudflare's static-asset layer serves the shell as `text/html` **with no charset**;
the Node backend serves the same file as `text/html; charset=utf-8`. The first version
of the audit demanded the header and went red on all three live environments.

Not a defect, and the reason matters: HTML has its own encoding rules — a browser
reads the transport charset first, and with none it falls back to the byte-order mark
and then to `<meta charset>` in the document. The shell declares it **at byte 62**,
well inside the 1024 bytes a browser will look at, so ₦ and *Ọ̀ṣun* render correctly on
both backends. The audit now asserts the rule that actually prevents mojibake: one of
the two declarations must exist, it must say utf-8, and when it is the in-document one
it must be within the first 1024 bytes. The API — where money and names travel — is
held to the strict rule and carries `charset=utf-8` on both backends. The difference is
printed as an audit **note**, so it is visible on every run instead of being
rediscovered.

## Negative controls — the audit was made to go red on purpose, twice

A check that has never failed is a check nobody has seen work.

1. `public/offline.html` replaced with a page rendering `${undefined}` → **the fallback
   check went red**, then green on restore.
2. `if (false)` wrapped around the scope filter in `GET /api/users` — a **real product
   mutation**, the exact shape of bug that ships — → **"a manager cannot see staff at
   another branch" went red**, then green on restore (file diff-verified byte-identical).

## Traps this stage added to the register

1. **`runAudit(name, fn, { setup })` returns `d = null` when the setup block is
   forgotten** — every check then reports "the action itself failed: Cannot read
   properties of null". The setup is what makes it a deployment, not a script.
2. **A live target may have no owner seat.** Production has exactly one account
   (the administrator), so a check that reaches for `d.owner` fails on the environment
   that matters most — it did, on both sample and production, as *"Cannot read
   properties of undefined (reading 'call')"*. A check must take whichever signed-in
   seat exists when any signed-in caller will do.
3. **`/api/auth/me` reports `user.branch` and `user.business` as OBJECTS**, with the
   pinned ids in `scope`. Reading `user.branch_id` yields undefined — and an assertion
   against undefined reports a scope defect the server does not have. Three checks in
   the first draft of this audit failed for exactly this reason.
4. **A username is never reusable, even by a deactivated user**, because their past
   sales are still attributed to them. A fixed fixture name (`http-injected`) worked
   once and then failed on the second live run with a correct `409 DUPLICATE_USERNAME`.
   Live fixtures get a per-run suffix.
5. **A PIN of `1234` or `12345` cannot be set through `POST /api/users`** (`PIN_WEAK`
   refuses a straight run) even though every deployment's administrator holds `1234` —
   the deploy tool writes that PIN straight into the database, which is a deliberate
   bypass for a client's first sign-in. Audit fixtures use `73041`.
6. **A self-reporting check is not also a pass.** `check()`/`checkAsync()` used to mark
   a skip *and* a pass, so the count grew for checks that asserted nothing and a suite
   could look more thorough the less it tested.
7. **An unauthenticated path that does not exist is `401`, not `404`** — the auth guard
   runs before routing, which is fail-closed and correct. With a token it is `404`
   JSON. The audit asserts both, and does not "fix" the app.
8. **A live deployment's administrator must be the seat that provisions fixtures.**
   An owner on a real deployment may itself be branch-pinned, and a pinned seat cannot
   create a user at another branch — the fixture failed with a `403
   BRANCH_SCOPE_VIOLATION` that was entirely correct and entirely useless.
9. **A live run must undo exactly its own work.** Live mode is READ-ONLY by default;
   `AUDIT_WRITE=1` permits fixtures. What it creates is *deactivated*, never deleted,
   because this product never deletes a person or a business — and it says so in its
   own output rather than pretending it cleaned up.

## Evidence

| Run | Result |
| --- | --- |
| `node test/audit/audit.http.js` (fresh local deployment) | **35 checks passed** |
| `node test/audit/audit.http.js` × staging / sample / production (read-only) | **26 passed, 2 reported** each — the two stand-downs are named in the output |
| staging in **write mode** (`AUDIT_WRITE=1`) | **34 passed, 1 reported** — the four scope checks run against real D1, real Workers, real latency |
| `node test/audit/suite.js` | 9 checks, "the audit suite is fit to run" |
| `bash test/run-audits.sh` | 1 audit, every check green, exit 0 |
| `npm run verify` | **348/348/0** (unit + integration + e2e) |
| Leftovers on staging after write-mode runs | **0 active** audit accounts (9 deactivated; the audit reports the count it retired) |

## Still open (T1's own debris, and what it hands to T2)

* The audit's live write-mode runs leave **deactivated** users behind by design. Point
  `AUDIT_WRITE=1` at staging, never at a client's production. Worth a `--clean` sweep
  of `http-*`/`audit-*` accounts at the top of a live write run, as the compliance probe
  already does for its `PROBE-` records.
* `PROBE_DEBUG` in `tools/frontend-compliance.js` still needs removing.
* The compliance screen's error path (a real 409 closes the modal with no toast) and
  the notifications bell on screen are still owed from Stage 11/12.
* **T2 next**: `audit.money.js` (sale → split payment → change owed → till → cash floor
  → safe → banking → void → ledger → trial balance) and `audit.wht.js` (VAT-inclusive
  extraction, WHT rates as data, the returns), both two-way: act, then read the figure
  back over HTTP.

# ---------------------------------------------------------------------
# CHECKPOINT — Stage T2: FOLLOW ONE NAIRA, AND THE BRANCH A LIST NAMES
# ---------------------------------------------------------------------
Date: 2026-10-06. `main` @ this commit. Suites: `audit.money` **69 checks**,
`audit.wht` **35**, `audit.http` **34 + 1 reported**, `npm run verify` **348/348/0**.

## What T2 set out to do

Follow one naira through the whole system and read the figure back at every hop from a
DIFFERENT endpoint than the one that wrote it: catalogue → drawer funded from the safe →
cash sale with change → the drawer's expected cash → the count at close → the safe → the
bank → the ledger → the trial balance → the VAT return → a credit sale and a payment
against it → a void → idempotency. Then the tax: VAT extracted FROM an inclusive price,
WHT on the GROSS, the rates as data, the returns and their due date.

Every figure asserted is either arithmetic the audit did itself from prices it read, or a
figure read back from a second endpoint. Nothing is mocked, nothing calls a service
function, and nothing touches a database — the whole audit runs over HTTP, which is the
only layer a shop's money actually travels through.

## The seven product defects T2 found and fixed (all deployed)

1. **A till float funded from the safe posted a BANKING entry** — the float invented a
   bank deposit that never happened, leaving "Cash at Till" short for the life of the
   business and reporting a bank balance the shop did not have.
2. **`resolveBranch` refused a caller who reaches exactly one branch** — "You have access
   to more than one, and the system will not guess", said to the owner of a one-shop
   business, on a screen that offered nothing to choose from.
3. **The price-list query handed the pricing engine every list it could find**, leaking
   wholesale prices onto retail sales; and it named a column (`customer_class_id`) that
   does not exist, so any sale naming a customer answered `500`.
4. **The safe ledger sorted same-second rows arbitrarily** (`created_at DESC, id DESC`),
   which made the hash chain accuse a shop of editing its own safe. Now `rowid DESC`.
5. **`salesService.validatePayments` read snake_case where callers pass camelCase** —
   `cash_tendered` and `change_given` were NULL on every sale. Found only by an audit that
   goes over HTTP; the unit tests called the function with the names it was reading.
6. **`CHANGE_OWED_NEEDS_CUSTOMER`** now says what it wants (a customer RECORD, not a
   walk-in name).
7. **The supplier payment posted the NET into a helper written for the GROSS** — the bank
   was short by the withholding while the supplier stayed in credit, and the entry
   balanced, so the trial balance reported nothing wrong.

## The two defects THIS stage's live runs found, and fixed

Both were found by running the audit against staging — where the data is real — and both
are in the class the register keeps filling with: **a screen that answers, wrongly, without
ever erroring.**

1. **A branch filter that was not applied.** `GET /api/sales?branch_id=X` returned every
   branch's sales; so did the tills list, the expenses list, the purchase orders, the
   adjustments, the transfers, the stocktakes, the returns, the deposits, the instalments,
   the customers, the debtors, the journal and the dashboard. An OWNER — the one caller
   whose scope reaches every branch — is exactly who gets it, because a branch-pinned
   manager is saved by their own scope. Nothing errored; the only symptom was a total
   larger than the shop named above it. Fixed with **`branchFilter()`** in
   `server/lib/respond.js`, applied to fourteen list endpoints: a named branch narrows the
   read, a branch the caller cannot reach is **refused** (403 `BRANCH_SCOPE_VIOLATION`, the
   same refusal a write naming another branch gets), and `?branch_scope=all` is the
   documented opt-out that still cannot widen the caller's scope.
2. **A row-scoped action demanded the branch it could read off the row.**
   `POST /api/tills/:id/close` and `POST /api/sales/:id/pay` both load the row — with its
   `branch_id` — and then asked for it again. No branch, no pin, more than one branch, and
   the answer was `400 BRANCH_REQUIRED`; the screens that call them
   (`public/js/views/till.js`, `sales.js`) send no branch at all, so **Close Drawer and
   Record Payment could only ever fail** for a multi-branch owner. `resolveBranch` now
   takes a `fallback` derived from the addressed row, used only when the caller reaches
   that branch — a cashier guessing another shop's till id still has their pin win and the
   endpoint still refuses the mismatch.

Both were proven by negative control: the filter was deleted from the route and the two
branch checks went red; the row fallback was removed and eleven checks went red.

## The audit/harness fixes that made the live run possible

* **A live run must clean up after its own failure.** An aborted run leaves a drawer open,
  and the next run died on `409 TILL_ALREADY_OPEN` six checks in. The audit now finds the
  drawers **belonging to its own account** (by ownership, not by branch — an aborted run
  may have traded at a branch this run does not use) and closes each at its expected count.
* **An empty safe and an already-funded drawer are shop states, not defects.** The audit
  funds a short safe (DEPOSIT, reason OTHER) and retries the float.
* **Assert MOVEMENTS, never absolutes, on a live target.** Staging already held ₦306,000
  at the till, ₦205,500 booked in and out of the safe and real banking; the first run
  reported a live shop's own trading as defects in a ₦34,000 sale. Cash at Till, the bank
  and the VAT return are now read before the audit trades and compared as deltas.
* **The drawer's revenue is counted from the till's OWN sales** (`?branch_id=` on the
  sales list, matched on `till_session_id`), not from a figure the audit keeps in its head.
* **The deployment sorts the owner's own branches first**, and the audit picks the branch
  its seat works at — a creation without a `branch_id` falls back to the oldest live
  business, and the audit's own branch then refused its own sale with
  `403 CROSS_BUSINESS_CUSTOMER`. Locally the fixture now carries **two** branches: a
  second shop that trades, so a dropped filter has something to leak, and never trades
  from the audit's own point of view.

## A live observation, recorded and NOT asserted: the two cash accounts do not move

On staging, **Cash in Safe reads −₦205,500 in the books while the branch safe ledger holds
₦4,000**. The product states the rule in two places — only BANKING moves the general
ledger, because cash moving between the drawer and the safe is still cash at the branch —
so the OUTFLOWS from the safe post (banking, an expense paid from the safe) and the
INFLOWS do not (a deposit, the till-close sweep). The first time a shop banks money that
reached the safe by a route the ledger never saw, 1010 goes negative.

It is a real reporting defect, it is already recorded as open work (the code says so at
the float; this file said so in the T1 checkpoint), and the fix is known: **post the
intra-cash moves** — DR 1000 / CR 1010 for a float, the reverse for a sweep — so the two
cash lines move while total assets do not. It changes the composition of a live balance
sheet, so it is its own stage with its own proof and its own negative controls. The audit
prints the two figures as a note every run, so it cannot be forgotten.

## The trap this stage added to the register

**A receipt number is unique PER BRANCH, so two branches legitimately carry `000012`.**
The audit matched sales by receipt number, found two, and accused the product of recording
a retried push twice — with a red check that looked exactly like an idempotency failure.
The idempotency path was correct all along; the audit was reading a branch-wide list with
no branch filter (which is how defect 1 above was found), and receipt numbers restart per
branch by design. Sales are now matched by **id**, and the branch filter is asserted
directly: the list for a branch must hold that branch's sale and no other branch's.

## Evidence

| Run | Result |
| --- | --- |
| `node test/audit/audit.money.js` (fresh local deployment, two branches, a manager seat) | **69 checks passed** |
| `node test/audit/audit.wht.js` | **35 checks passed** |
| staging, **write mode**: `audit.money` | **69 checks passed** (17.2s, real D1 + Workers) |
| staging, **write mode**: `audit.wht` | **35 checks passed** |
| staging, **write mode**: `audit.http` | **34 passed, 1 reported** (the documented non-ASCII stand-down) |
| `bash test/run-audits.sh` | 3 audits, every check green, exit 0 |
| `npm run verify` | **348/348/0** |
| negative controls | dropped branch filter → 2 checks red; removed row fallback → 11 checks red; restored → green |

## Open items this stage leaves behind

1. **The cash-account split** (above): post the intra-cash moves so Cash in Safe cannot
   read negative. Recommended next, as **T2b**, with its own checks and negative controls.
2. **Deposits into the safe have no source.** Posting them needs to know where the money
   came from (bank withdrawal, owner's capital, till sweep), so the safe-entry route wants
   a `source` field before 1010 can be a true account.
3. Still owed from Stage 11/12: the compliance screen's error path (a real 409 closes the
   modal with no toast), `PROBE_DEBUG` in `tools/frontend-compliance.js`, and the
   notifications bell on screen.
4. A `--clean` sweep of `http-*`/`audit-*` accounts and `PROBE-`/`AUDIT-` fixtures at the
   start of a live write run — the audits retire their own users but leave stock, sales and
   safe entries behind, by design, on a staging deployment.

## Deployment — all three environments on `969cd27`

| Environment | Result |
| --- | --- |
| staging | deployed, `ready`, 2 businesses trading; write-mode audits: money 69 ✅ · wht 35 ✅ · http 34 + 1 reported |
| sample | deployed, readiness 6 checks, `awaiting_first_business`; read-only http audit **26 passed, 2 reported** |
| production | deployed, readiness 6 checks, `awaiting_first_business`; read-only http audit **26 passed, 2 reported** |

The two reported checks on the handover environments are the documented stand-downs (no
manager seat to create on a read-only target, and no non-ASCII fixture on a deployment the
audit did not provision). Both are named in the output, not silently skipped.

## Stage T2b — the safe is an account (2026-10-06)

Twelve things were true about cash in Stage T2 and one thing was not: the branch safe had a
ledger, a screen and a physical cash count, but **no ledger account**. Money could go into it
and the trial balance would not move; it could come out and the books would not notice. T2b
makes the safe a real account and proves, end to end, that every way cash enters or leaves it
reaches the journal.

### What shipped

- **`6910 Cash Over & Short`** as a real account, created by `schema/migrations/0005_cash_over_and_short.sql`,
  which also backfills the account onto existing businesses. A till that counts short now has
  somewhere to put the difference instead of a silent adjustment.
- **`CASH_ACCOUNTS`** in `server/services/glService.js`: `TILL 1000`, `SAFE 1010`, `BANK 1020`,
  `POS 1030`, `MOBILE_MONEY 1040` — one map, so a cash account is named in one place and every
  route that moves cash asks the same table which account it meant.
- **Cash-move helpers**: `postCashMoveStatements`, `postCashAgainstAccountStatements`,
  `postCashPayoutStatements`, `postCashOverShortStatements`. Every one validates its
  `source_type` against the closed `SOURCE_TYPES` list rather than inventing a type.
- **Deposits into the safe must declare a `source`** (BANK / OWNER / TILL / OTHER) and
  withdrawals a `destination` (OWNER / EXPENSE / OTHER); missing → `400 SAFE_SOURCE_REQUIRED` /
  `SAFE_DESTINATION_REQUIRED`. This is the T2 note-2 gap closed: the old route could take money
  with no record of where it came from.
- **`POST /api/safe/reconcile {counted_balance?, note}`** (manager or better): posts the gap to
  6910 and audits `SAFE_RECONCILED`. `GET /api/safe` now returns `balance`, `ledgerBalance`,
  `difference`, `inAgreement`, `agreementMessage`, `chainConsistent`, `chainMessage` beside the
  rows, so the screen can show the two figures side by side instead of one number pretending to
  be both.
- **A branch's `opening_cash` posts DR 1010 / CR 3000 (`OPENING_BALANCE`)** in
  `provisioningService` — a branch that opens with money in the safe has that money on the books
  from the first minute.
- **`public/js/views/till.js` complete**: the safe screen, the drawer count, the variance and the
  reconciliation, with the books and the ledger shown together.
- **A real product defect repaired** (below).

### The defect: `POST /api/expenses` with `payment_method: 'SAFE'` had never once worked

The new audit check — an expense paid from the safe — came back
`500 {"error":"bal is not defined"}`. Then, after that fix, `500 {"error":"approvedBy is not defined"}`.
Then, after that one, it posted and moved **nothing**, because it credited the till while the money
left the safe. Three defects in one branch, and the reason is visible in hindsight: **this path had
never completed a single run**, so no later defect in it was reachable to be seen.

| # | Defect | Fix |
| --- | --- | --- |
| 1 | The insufficiency guard read `bal`, a variable that does not exist in `server/routes/till.js` | Read `safeBalBefore` from the safe's own ledger when the payment method is chosen; `409 SAFE_INSUFFICIENT` names the balance and both remedies |
| 2 | The `branch_safe_ledger` INSERT bound `approvedBy`, also never defined in the route | `approved_by` is the acting user — the person who signed the payout off — with a comment saying so |
| 3 | The GL credit went to **Cash at Till** because `expenseRow` carried no `paid_from`, and `postExpenseStatements` defaults to the till | `paid_from` is now set from the payment method: SAFE → SAFE, CASH → TILL, everything else → BANK |

Defect 3 is the one worth remembering: **the table's column and the object's field are two names
for one fact, and only one of them was being written.** The safe ledger said money had left the
safe; the books said the till was short. Both records drifted, in opposite directions, on the
shop's most ordinary transaction — and the audit's one-line diagnosis was
`the safe ledger says ₦160,000 and the books say ₦163,000`.

Nothing else in the suite touched this path: the WHT audit pays expenses from the till, and the
unit tests call `glService` directly rather than the route. **A route-level test for every
checkout and payout path is now the standard** — a 500 here reads to a shopkeeper as a broken app.

### Audit corrections (the audit's bugs, not the product's)

- `test/audit/audit.wht.js` asserted the unremitted total as an **absolute**: "the report says
  ₦12,000 is unremitted" was the shop's real tax debt plus the audit's ₦8,000, reported as a
  failure. It now reads the unremitted figure *before* the payment and asserts the **movement**.
  Same mistake the money audit made with the bank balance, in a different report — a live target
  carries history and an absolute can only ever be true on an empty database.
- (from the earlier part of this stage) `sharedTick` reassignments that dropped keys, a `before`
  reading taken after the drawer opened, `tillAccountBefore` read after the float, the reconcile
  note printing the post-correction residual as "posted", and two checks reading account movements
  that no account had yet.

### Proving it

- **Local:** `npm run verify` **348/348/0**; `bash test/run-audits.sh` — 3 audits, every check green;
  `test/audit/audit.money.js` **82 checks passed**.
- **Negative controls** (both restored after): float not posting → **4 checks go red**; variance not
  posting → **1 goes red**. Restored → green.
- **Live staging, write mode:** `audit.money` **83/83 (28.6s)** — headline note
  `Cash in Safe: books ₦47,000 vs the branch safe ledger ₦47,000`, and
  `diesel: 6020 now ₦2,790.7; the safe and the books both moved by the same ₦3,000` ·
  `audit.wht` **36/36 (12.5s)** · `audit.http` **34 passed, 1 reported**.
- **Sample and production (read-only):** `audit.http` **26 passed, 2 reported** each on migration 0005.

### Deployment — all three environments on migration 0005

| Environment | Result |
| --- | --- |
| staging | migration 0005 applied; readiness 6 checks, `ready` (2 businesses trading); write audits **money 83 ✅ · wht 36 ✅ · http 34 + 1 reported** |
| sample | migration 0005 applied; readiness 6 checks, `awaiting_first_business`; read-only http audit **26 passed, 2 reported** |
| production | migration 0005 applied; readiness 6 checks, `awaiting_first_business`; read-only http audit **26 passed, 2 reported** |

### Open for T3

1. The `--clean` sweep for `http-*`/`audit-*` accounts and `PROBE-`/`AUDIT-` fixtures is still
   unwritten; staging now carries the residue of several write runs by design.
2. Stage 11/12 leftovers: the compliance screen's error path (a real 409 closes the modal with no
   toast), `PROBE_DEBUG` in `tools/frontend-compliance.js`, and the notifications bell.
3. Every checkout/payout path needs its own route-level check — done for the safe; the till,
   bank, POS and mobile-money expense methods are asserted only through the service.

## Stage T3 — the role matrix, a file per pair (2026-10-06)

T1 proved the contract at the edge. T2 and T2b proved the money. T3 asks the question
underneath all of them: **for this seat, is the product allowed to work at all** — and is the
answer the one the product's own role module gives?

### What shipped

- **`test/audit/lib/role-rules.js`** — the matrix, READ FROM THE PRODUCT'S OWN RULES. It
  `require`s `domain/roles.js` and calls `canManageUser`, `canResetPin`, `canChangeRole`,
  `outranks` and `atLeast` for every expectation, then holds the API to the answer. A test
  that restates the hierarchy passes forever, including after somebody changes it; this one
  moves with the rule and fails when a route and the rule disagree. It also owns
  `expectRule()` (allow-or-refuse, with the message quality asserted on the refusal) and the
  pair-file helpers `makeUser()` / `signIn()`.
- **`test/audit/audit.roles.js`** — the entry audit: five seats (admin, owner, a manager and
  a cashier in branch A, a manager and a cashier in branch B), the declared hierarchy probed
  over HTTP against real people, self-change, PIN resets, the floor boundary, what each seat
  can see, cross-branch scope, and **a gate that refuses the suite if a role pair has no
  file**. A missing pair is a question nobody asked, and it looks identical to a pair that
  passes.
- **`test/audit/pairs/`** — six files, one per unordered pair: `admin-manager`,
  `admin-owner`, `admin-staff`, `manager-staff`, `owner-manager`, `owner-staff`. Every rule
  in them is probed in BOTH directions — the lower role refused AND the higher role allowed —
  because a product that refuses everything is not secure, it is broken, and a suite that
  only asserts 403 will certify it. They also carry the lifecycle probes: hire, move between
  branches, the dashboard-follows-the-person test, deactivate, reactivate, reset a PIN, void
  another person's sale, approve the counter's expense, open and close a drawer, sign it off.

### The product change this stage forced: the books are not a cashier's to read

`requireBooks(ctx)` in **`server/routes/accounting.js`** now guards the trial balance, the
profit and loss (and its by-category breakdown), the balance sheet and the journal at
**MANAGER and above**. Before it, any account holding a token — including the cashier on the
shared phone at the counter — could read the shop's margins, its trading position and what it
owes FIRS. Margins are the most commercially sensitive numbers a shop owns, and the person
most likely to be negotiating a discount or leaving for a competitor is the one at the till.

One deliberate exception, written where the exception lives: **`GET /api/accounting/wht` stays
open to the floor.** A storekeeper receiving goods has to see what was withheld from the
supplier standing in front of them; hiding it does not protect the business, it pushes the
arithmetic onto paper. `audit.wht.js` already asserted both halves of that (a staff seat can
read the position, and cannot file it), which is why the first draft of `requireBooks` — which
guarded all seven endpoints — was wrong and the suite said so within one run.

### Proving it

- **Local:** `test/audit/audit.roles.js` **142 checks passed**; `bash test/run-audits.sh`
  — **4 audits, every check green**; `node test/audit/suite.js` — **15 checks, 4 audits wired**;
  `npm run verify` **348/348/0**.
- **Live staging, write mode:** `audit.roles` **147 checks passed (46.7s)**.
- **Negative control:** the rank gate on `POST /api/users` was bypassed in
  `server/routes/admin.js` (`if (false && !canManageUser(...))`) and the suite went red in
  **exactly four places, across four different files** — the cashier cannot create a user, the
  manager cannot create a manager, the cashier cannot add anybody, the manager cannot appoint a
  manager. Restored → 142 green. It is the control that matters: it proves the pairs reach the
  ROUTE and not the domain function.

### What the live run taught (fixture bugs, not product bugs — but only visible live)

| Symptom on staging | Cause | Fix |
| --- | --- | --- |
| `403 CROSS_BUSINESS_MOVE` on three move probes | `branches[1]` was another business's first branch | derive a same-business destination (`ctx.otherBranchFor`); open a second branch when the deployment has only one, and close it on the way out |
| `409 DUPLICATE_BRANCH_CODE` | the auto-derived branch code collided on the third run | the probe states its own unique code |
| `"assert is not a function"` on four passing checks | `const { assert } = require('node:assert')` — destructuring a callable | `require('node:assert')` |
| the owner's branch list "leaked" another business | it does not: `business-access` declares `reachesEverything: true, reachesEverythingBy: ROLE:OWNER` | the check derives the declared reach and reports it |
| the owner's PIN could not be put back | `12345` is a straight run and the strength rule refuses to re-set it | restore the seat's own PIN when the product allows; when it does not, print `⚠ THIS SEAT NOW HOLDS PIN …` so nobody is left locked out |
| `402 MAX_BRANCHES_REACHED` on the branch probes | staging is at its plan's branch ceiling | a plan limit is a SHOP STATE: reported, not failed |
| `409 BRANCH_INACTIVE` when seating | the harness picked a branch an earlier run had closed | both harness paths now keep only active branches |

**The one that mattered:** the first live run of `audit.roles` changed the `liveseat` owner's
PIN on staging and walked away. The next run could not sign in at all. A live deployment belongs
to somebody, and a test that leaves a client locked out of their own shop is worse than any bug
it could find — the audit now restores the PIN it found, or says in capitals what the seat holds.

**Open, for the record:** an OWNER reaches every business on the deployment, by role. That is
declared behaviour and correct for one client per deployment; it is the line to re-examine the
day a single deployment hosts two clients owned by different people. Recorded here so the
decision is deliberate rather than accidental.

### Deployment — all three environments carry `requireBooks`

| Environment | Result |
| --- | --- |
| staging | deployed; write-mode: **roles 147 ✅ · money 83 ✅ · wht 36 ✅ · http 34 + 1 reported** |
| sample | deployed; read-only http audit **26 passed, 2 reported** |
| production | deployed; read-only http audit **26 passed, 2 reported** |

### Next: T4 — sync, idempotency, concurrency and the D1 limits

The plan for T4 is unchanged: two clients writing the same row (LWW with conflict capture),
the same `Idempotency-Key` replayed, a request retried after a timeout, concurrent tills
against one product's stock, and the D1 ceilings — statements per request, row size, the
`batch()` limit — probed against the live deployment rather than assumed.

## Stage T4a — sync, idempotency, and what the offline queue actually gets back (2026-10-06)

The offline-first promise is the product's hardest claim and the one no demo can show. T4a is
the audit that makes a phone's day testable: queue work, push it, push it again, edit a row
somebody else has changed, and try to write your way into another branch.

### Two real product defects, both found on the first run

**1. A partial push answered 500 on every deployment with more than one branch.**
`POST /api/sync/push` records `SYNC_PUSH_PARTIAL` when anything was refused or conflicted, and
that record read `branch.id` — but `branch` is **null** by design whenever the caller covers
more than one branch and did not name one (an owner with two shops, a deployment
administrator). The route's own comments say requiring a branch up front would fail a
cashier's whole day over one malformed item. So the answer to *"three items in my queue were
rejected"* was `500 Cannot read properties of null (reading 'id')` — with no per-item detail —
on exactly the deployments that matter. A 500 is the one answer an offline queue cannot act
on: it cannot tell a bad item from a bad server, so it retries the batch forever and the queue
never drains. Fixed by making the record null-safe; the stack was found by attaching the
original error as `cause` in `toHttpError` (a TypeError turned into a 500 used to lose the line
that caused it), which is kept.

**2. `Idempotency-Key` was honoured on `POST /api/sales` and nowhere else.**
The library, the table and the protocol all existed; one endpoint used them. Every other
money-moving endpoint accepted the header and IGNORED it, so a retried request on a flaky
network did the thing twice: an expense paid twice, a till float doubled, a layaway deposit
taken twice, a supplier paid twice. Found by asking `/api/expenses` for the same key twice and
watching two different records come back (`911cf497…` and `c4a37964…`), then watching the same
key with a *different* body answer 201 and apply.

**21 further money-moving endpoints are now wrapped in the same protocol** — the till (open,
close, review), the safe (entries, reconcile), expenses (create, approve), sale void and
payment, delivery and installation status, supplier payments, purchase-order receipt, stock
receive and adjust, customer payments, returns, return approval, and deposit and instalment
payments. Verified by `grep -rc 'idempotent(async (ctx)' server/routes/*.js`: sales 6 · till 7 ·
afterSales 4 · finance 2 · stock 2 · customers 1.

### What the audit asserts

- **A queued sale lands exactly once.** Pushed, pushed again after a simulated timeout: the
  branch gains ONE sale, not two. This is the check the whole offline promise rests on — a
  shop that sells one generator and banks two of them finds out at stocktake, a month later.
- **Conflicts are captured with both versions.** The device's stale edit loses, the server's
  version stands, and the losing version is stored in `sync_conflicts` with the text the device
  tried to write — then a manager resolves it, and resolving it twice is refused.
- **A device cannot write its way out of its branch**: `branch_id`/`business_id` are refused as
  `SCOPE_COLUMN_FORBIDDEN`, a table with its own rules (sales) is refused as
  `TABLE_NOT_SYNCABLE`, a mutation for a row that no longer exists is skipped rather than
  treated as an insert, and one bad item does not stop the rest of the batch.
- **A push must name its device** (`DEVICE_ID_REQUIRED`), an empty push is refused
  (`EMPTY_SYNC`), more than 500 items is refused (`SYNC_BATCH_TOO_LARGE`), and an operation with
  no idempotency key is refused per-item (`IDEMPOTENCY_KEY_REQUIRED`).
- **A branch-pinned pull does not carry another branch's customers** — the offline mirror on a
  phone that leaves the building.

### Two things the audit had to learn about the product, recorded so the next reader does not guess

- **A partial push is HTTP 207** (Multi-Status), with `results.operations` and
  `results.mutations` nested under `results`, and a per-item `status`/`code`/`message` for
  every item queued. 207 is the right answer: a device has to be able to tell "the whole queue
  landed" from "three items need a person".
- **`updated_at` has SECOND precision** (`datetime('now')`), everywhere. LWW decides "the
  server changed after this device last saw it" by comparing those strings, so an edit and a
  push inside the same second are indistinguishable and the device wins the tie. The audit
  waits past the tick to measure the conflict path rather than the tie-break. **Open for T6:**
  a same-second concurrent edit is possible (two devices, one office) and the loser is told
  nothing. The fix is sub-second timestamps on the LWW-comparable columns; the comparison stays
  correct because the format still sorts lexicographically.

### Proving it

- **Local:** `audit.sync.js` **35 checks passed**; `bash test/run-audits.sh` — **5 audits, every
  check green**; `node test/audit/suite.js` — 17 checks, 5 audits wired; `npm run verify`
  **348/348/0**.
- **Negative control 1:** `idempotent()` removed from `POST /api/sales` (a pass-through with the
  same signature, route otherwise identical) → **the retry check goes red** — and only it.
- **Negative control 2:** the null-safe fix reverted in the partial-push record → **8 checks go
  red**, every path that answers a partial push. Both restored → 35 green.

## Stage T4b — a branch can have two phones (2026-10-06)

The live sync run found one thing the local run could not, and it was a schema decision
rather than a bug in a line of code.

**`branch_sync_status` could hold ONE DEVICE PER BRANCH, and its upserts never wrote
`device_id`.** The table was created with `branch_id TEXT PRIMARY KEY`; the heartbeat, the push
and the pull all upserted `ON CONFLICT(branch_id)` and none of them touched `device_id` on the
update path. So `/api/sync/status` — the screen that answers *"which tills are actually syncing,
and which one is stuck with a queue?"* — could only ever name the FIRST device that had synced
at a branch. The second phone was invisible, and the `pending_push_count` and `last_sync_error`
it reported were attributed to the other device. A `last_sync_error` belonging to a device
nobody can see is an error nobody can fix.

A shop with a counter phone and a manager's phone is the ordinary case. Found by
`test/audit/audit.sync.js` pushing a heartbeat from a second device and reading the status list
back — a check that did not exist until this stage, which is why the defect survived the whole
T1–T3 line of work.

### The fix

- **`schema/migrations/0006_sync_status_per_device.sql`** — the table is rebuilt with
  `PRIMARY KEY (branch_id, device_id)`, the shape the endpoint's own field name (`devices`)
  always claimed. Existing rows are carried across (a row with no device is dropped rather than
  invented). `v_branch_sync_overview` — which SQLite validates against its tables when one is
  dropped, so the migration **refuses before changing anything** — is dropped first and
  recreated to judge each branch by the device heard from most recently, so the view's meaning
  does not change when a branch gains a second phone.
- **All three upserts** (heartbeat, push, pull) now conflict on `(branch_id, device_id)`.
- **The check that would have caught it**: two devices heartbeat into one branch and BOTH must
  appear, exactly once each, with each one's own pending count.
- `tools/capability-baseline.json` records `branch_sync_status_v2` for what it is — the
  intermediate name of a SQLite table rebuild, not a capability. The scanner reads every
  `CREATE TABLE` in every migration, so a rebuild always lands in its report; the baseline is
  where that decision belongs rather than a silent exception in the scanner.

### Proving it

- **Local:** `audit.sync.js` **36 checks passed**; `bash test/run-audits.sh` — 5 audits, every
  check green; `npm run verify` **348/348/0** (capability audit clean at 8 baselined entries).
- **Negative control:** the heartbeat's conflict target reverted to `branch_id` alone → the
  heartbeat 500s (`ON CONFLICT clause does not match any PRIMARY KEY`) and **3 checks go red**,
  including the two-device check. Restored → 36 green.

### T4 live proof — staging, write mode, after migration 0006

| Audit | Result |
| --- | --- |
| `audit.sync` | **36 checks passed** (13.3s) — including the two-device check against real D1 |
| `audit.money` | **83 checks passed** (25.7s) — the regression check for wrapping 22 endpoints in the idempotency protocol |
| `audit.roles` | **147 checks passed** (46.3s) |
| `audit.wht` | **36 checks passed** (11.7s) |
| `audit.http` | 34 passed, 1 reported |

Sample and production carry migration 0006 and both answer the read-only `audit.http` with
**26 passed, 2 reported**.

**Next: T4c** — concurrency on one product's stock from two tills, a request retried after a
timeout, and the D1 ceilings (statements per request, row size, batch limit) probed against the
live deployment rather than assumed. Then T5 (the three-month simulation) and T6 (go-live docs).

### Stage T4c — the catalogue could not be written at all

Two real defects, both live on all three deployments, both found by a new audit that builds its
own goods instead of borrowing the seeder's:

**1. Every product create and edit answered 500 `check.ladder is not iterable`.**
`validateLadder` (`domain/uom.js:104`) returns its normalised rows under **`levels`**.
`buildLadder` — the other function in the same module, whose result every *other* caller in the
codebase reads — returns **`ladder`**. `server/routes/catalog.js` read `check.ladder` at three
sites (create `:387`, create's barcode `:403`, update `:453`). Every create and every edit failed
*after* the product row had been inserted, so each failure left behind a product with no unit
ladder: a row the shop can see, cannot sell, and — because the edit path failed too — could not
repair. The app's own New Product and Edit Product screens (`public/js/views/products.js:339-340`)
were dead on every environment.

**2. Every ladder replacement answered 409 `DUPLICATE`.**
`product_units` carries `UNIQUE (product_id, code)` as a **table constraint**, not an index
filtered on `is_deleted`, so the row the update route soft-deleted a line earlier still occupied
the code. Every ladder keeps `PIECE` (level 0 must be exactly 1 base unit), so **no product's
units could ever be edited**. Fixed with revive-or-insert
(`ON CONFLICT(product_id, code) DO UPDATE … is_deleted = 0`) — the same shape `server/routes/admin.js`
already uses for a re-granted business access and `catalog.js` itself uses for price overrides,
both of which carry a comment saying why. `product_units` was the one place the rule was missed.

**Found by** `test/audit/audit.concurrency.js` (new; 19 checks). Its wide-sale section creates the
catalogue it sells through `POST /api/products` rather than borrowing the seeder's, so the create
path was exercised on its first run — after an earlier version of that section had **silently
skipped** ("the catalogue has 6 priced, untracked products"), which is the hollow coverage a skip
can hide: the check guarding the live database's parameter limits was not running at all.

**Proof**
* local: `audit.concurrency` **19 checks passed**;
* live staging: create → **201** with a `PIECE×1` ladder; edit → **200**, units after →
  `PIECE×1, CARTON×12`;
* the two ghost products (0 units) the defect left on staging were swept by SKU prefix —
  3 rows soft-deleted, 0 remaining; sample and production were checked and had none;
* `npm run verify` **348/348/0**; `test/audit/suite.js` **6 audit(s) wired, 19 checks passed**;
* sample + production redeployed with both fixes; both answer the catalogue probe
  "no business yet — the expected handover state" (one admin account, no business).

**New files:** `test/audit/audit.concurrency.js`, `test/audit/probe-catalog-write.js` (the
reproduction, kept because it is the only check that runs the write path against a live
deployment a client uses).

**Still owed from T4:** `audit.sync.js` reds (idempotency is wired on `/api/sales` only; the queued
SALE push returned non-200; harness device-header and `branch_id` fixes), then the D1
statement/row/`batch()` ceilings.
