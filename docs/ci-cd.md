# CI/CD

Two workflows, and the reason there are two is the load-bearing detail.

| Workflow | Trigger | What it proves |
|---|---|---|
| [`ci.yml`](../.github/workflows/ci.yml) | Every push to every branch, every pull request | The audits and the 260 tests pass **and** the Worker bundles |
| [`deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml) | **Manual only** | A chosen human decided to deploy, and the gates passed first |

## Why the second CI job exists

`ci.yml` has two jobs, `verify` and `worker-bundle`, on different Node versions —
and that is not tidiness.

**A real defect motivated it.** `worker/src/index.js` used only
`module.exports`, so wrangler read it as a legacy **service-worker** script and
its `nodejs_compat` plugin then refused every `node:*` import:

```
Unexpected external import of node:crypto, node:events, node:perf_hooks
… Your worker has no default export.
```

Every one of the 251 tests passed. The deploy could not build at all. The test
suite runs the *routes*; it never bundles the *Worker*.

`wrangler deploy --dry-run` catches that entire class — module format, unresolved
imports, missing bindings, a `wrangler.toml` that does not parse — in about
fifteen seconds, **with no credentials**. It is the cheapest possible check on
the most expensive failure, so it runs on every push.

| Job | Node | Runs |
|---|---|---|
| `verify` | 20.11 (the server's minimum) | `npm ci`, then `db:audit`, `names:audit`, `args:audit`, then the full suite |
| `worker-bundle` | 22 (wrangler's minimum) | `npm ci`, then `wrangler deploy --dry-run --config worker/wrangler.toml` |

The audits run as their own step so that a finding reads as **a finding**, not as
one more failing test in a list of 260.

`npm ci`, not `npm install`: the lockfile is committed, and a build that resolves
different versions than the developer's is a build nobody tested.

## The third job: the frontend is rendered, not just assumed

`frontend-render` seeds the demo database, starts the Node server, loads
`public/index.html` in jsdom and asserts the navigation actually reaches the DOM for
all four roles. It exists because of a real defect that every other check passed:

```
SR.state = Object.assign(state, { branches, … })   // branches is the accessor
state.branches = data.branches                     // …and now it is the array
```

so `SR.state.branches()` threw inside `paintIdentity()`, which `showShell()` ran
*before* `buildNav()` — the sidebar was empty for **every role on every
deployment**, while every API answered 200 and 272 tests passed. Nothing that
tests routes can see that. Only rendering it can.

jsdom and fake-indexeddb are installed in that job alone and **pinned**
(`jsdom@29.1.1`, `fake-indexeddb@6.2.5`) on **Node 22**. They are not
dependencies of the product — the application ships with no build step, and the
test client should not become part of it. Unpinned, `jsdom` resolved to a version
the job's Node could not load; the pins keep the instrument still.

### Running it yourself

```
# against a live deployment
node tools/frontend-smoke.js --url=https://sample.stockridge.workers.dev \
  --user=admin --pin=48213

# against the local demo database, every role
npm run db:reset && npm start &        # then
node tools/frontend-smoke.js --url=http://localhost:8787 --all-roles --walk
```

| flag | what it does |
|---|---|
| `--url=` | server origin (default `http://localhost:8787`) |
| `--user=` `--pin=` | one seat to sign in as |
| `--all-roles` | ADMIN, OWNER, MANAGER and STAFF in turn (seeded demo credentials only) |
| `--walk` | **open every destination in the navigation** and report what each screen renders |
| `--dump` | print the visible screen, the DOM state and the page's own console |
| `--expect-nav=N` | fail unless the nav has at least N items (default 1) |
| `--wait=N` | ms to wait for the app to settle (default 30000) — it polls, it does not sleep and hope |

### Auditing the schema against what uses it

```
npm run caps:audit            # node tools/capability-audit.js --strict
node tools/capability-audit.js --all --json
```

The schema is large on purpose — instalments, layaway holds, warranty and serial
tracking, wholesale price tiers, delivery and installation jobs, the debtor ledger,
branch safes, geofenced attendance, the chained audit registers, the ledger and the
WHT schedule. This audit asks, for every table: does any code **create** it, does any
code **read** it, is it **seeded** reference data, is it **exposed** by a route, and
does the **frontend** ever call that route?

It reads the statements, the route registrations and the frontend's own API paths, so
it cannot drift from any of them. Two things it knows that a naive scan does not:

* the hash-chained registers are appended through a helper that takes the table name
  as an **argument** (`appendChained(db, { table: 'audit_log', … })`), so a scan for
  INSERT statements reports them as "read but never created" — which it did, about
  the one table whose completeness is a security claim, until this was fixed;
* `${…}` and `:param` are normalised out of both sides before comparing, so
  `/api/stock/:id/batches` and `` `/api/stock/${id}/batches` `` are recognised as the
  same path.

`--strict` fails only on the indefensible verdict: a table that nothing creates.
Eight such tables exist, and each one is written down in
`tools/capability-baseline.json` with **what it is for** and what is to be done about
it — a to-do list rather than a pile of noise. A ninth, added by a future migration
and wired to nothing, fails the build. The report's other sections (written but never
read, internal only, routes no screen calls) are findings for a person, not verdicts,
because "written and never read" is occasionally exactly right.

### Probing every role, in both directions

```
# the four seats of a seeded demo database, every destination, every guarded GET
node tools/frontend-roles.js --url=http://localhost:8787 --walk

# a live deployment, naming the seats
node tools/frontend-roles.js --url=https://stockridge-staging.stockridge.workers.dev \
  --seat=admin:1234 --seat=liveseat:48213 --walk
```

`frontend-smoke.js` answers "does this screen draw?". This one answers the harder
pair of questions: **does each kind of user get the capability the roles table says
they get — and are they actually refused the ones it says they may not have?**

| flag | what it does |
|---|---|
| `--seat=user:pin[:ROLE]` | a seat to probe (repeatable); without it, the demo database's four |
| `--walk` | open every destination that role's navigation offers, and compare it against the routes the app declares for that role |
| `--list` | print every guarded endpoint the probe found, straight from the server's source |
| `--deep-writes` | also call guarded writes with an empty body — **opt-in, never against a customer's live deployment** |

What it checks, and why each half matters:

* **The navigation a role is given** must equal the destinations the route table
  grants that role. A missing one is a capability nobody can reach; an extra one is
  a screen that will refuse them at the first request.
* **Every guarded endpoint, called with that role's token.** A route whose guard
  demands more authority must answer 403; a route the role is entitled to must not.
  A 5xx anywhere is a defect. A 2xx for a role the boundary excludes is the
  dangerous direction — the capability was not refused — and it is the one nobody
  tests.

The expectations come from two independent places on purpose. The first is the
server's own source (derived, so it cannot drift and cannot be forgotten). The
second is `CRITICAL` inside the tool — a hand-written list of the boundaries that
matter most, taken from `domain/roles.js`. The derived list catches a guard that
exists but does not run; the hand-written one catches a guard that was **deleted**,
because deleting it also deletes the derived expectation. Both were proved by
breaking the code on purpose (see `STATUS.md`, Stage 7).

Only GETs, plus critical writes for roles below their boundary, are called: probing
a guarded POST with a real payload would create the thing it protects. Below-guard
writes are safe because an empty body can only be refused or rejected — it cannot
create anything valid out of nothing. The report says how many paths were skipped
for needing an id rather than implying coverage it does not have.

### Ringing a sale through the screen

```
node tools/frontend-sale.js --url=https://stockridge-staging.stockridge.workers.dev \
  --user=<seat> --pin=<pin> --product=Anker
```

This is the check that asks whether the application can be **operated**, not merely
rendered: it opens the Sell screen from the navigation, types a product into the
search box, chooses the result, answers the variant question if one is asked, adds
the payment, completes the sale, reads the receipt, and then asks the API whether
that receipt exists. It exits non-zero if a receipt does not come back or the server
does not have the sale.

It found five defects that 284 passing tests could not see, including a whole
vertical where nothing could be sold at all (see the checkpoint in `STATUS.md`).
Run it against a **scoped seat with stock on the shelf**; a seat that can reach more
than one branch and has not chosen one will be refused by design, and the tool says
so rather than reporting it as a fault.

Both tools share `tools/lib/page-harness.js` — the awkward part of driving this
application headlessly is booting it (plain `<script>` tags in page order, a real
IndexedDB, `matchMedia`, a live server with a token), and that now lives in one
place.

`--walk` is the useful one after a change: it opens all 25 owner screens (or 21
manager, 12 staff, 7 admin) and reports the ones that render nothing. A screen
that deliberately refuses — *"Choose which branch this applies to"* — is reported
with a `!`, not failed: it rendered, and it told the truth. Only a screen that
renders **nothing**, or throws, counts as a defect.



It deploys to production and it can seed an administrator. A workflow that does
that on every push to `main` takes the decision away from the person who should
be making it — and the group that pays for a bad deploy at 8am is a shop floor
with a queue at the counter.

## Enabling the deploy workflow

1. **Add the secrets.** Repository → Settings → Secrets and variables → Actions:

   | Secret | Required | Value |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | Yes | Account · Workers Scripts · Edit, Account · D1 · Edit |
   | `CLOUDFLARE_ACCOUNT_ID` | No | Resolved from the token when absent |

2. **Run it.** Actions → *Deploy to Cloudflare* → **Run workflow**. Two inputs:

   | Input | Default | Effect |
   |---|---|---|
   | `dry_run` | false | Everything except the deploy itself — the safe way to check that CI's credentials work |
   | `reset_pin` | false | **Overwrites** the administrator's PIN. Only for a genuinely lost PIN. |

3. It runs `npm run verify` **before** deploying, so the workflow cannot ship
   anything that CI would have rejected. If you want to deploy without the gates,
   run `node tools/deploy-cloudflare.js` locally instead — going through the UI
   for that is a worse idea than it looks.

The workflow writes a summary to the run page: the Worker URL, the diagnose link,
and which inputs were used.

## What is NOT in CI, and why

- **No test against a real D1 database.** A D1 instance per pull request means a
  Cloudflare credential in every fork's reach, and a suite that fails when the
  network does. The D1-specific risk is covered differently: `worker/src/d1.js` is
  a thin adapter over the same seven methods as `server/lib/db.js`, and the
  end-to-end suite exercises the routes over the *Node* adapter. The remaining
  gap is real and is recorded in [../STATUS.md](../STATUS.md) — it is closed by
  running the first-run journey against a staging database by hand, not by
  pretending CI covers it.
- **No deploy on push to `main`.** See above.
- **No linting step.** The three audits in `tools/` check things no linter can
  (`names:audit` finds a function called but never imported; `args:audit` finds a
  call passing keys the callee ignores; `db:audit` finds a statement whose
  placeholders do not match its values). Adding ESLint would be additional noise
  on top of checks that already target this codebase's actual failure modes.

## Branch protection (recommended, once the repo has collaborators)

Settings → Branches → protect `main`:

- Require the **CI** status checks (`Audits and tests (Node 20)`,
  `Worker bundle (Node 22)`) to pass before merging.
- Require a pull request, so a change is read by somebody before it is deployed.
- Do **not** require linear history while `archive/pre-restructure-20261004`
  exists; the history is intentionally not linear.
