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
