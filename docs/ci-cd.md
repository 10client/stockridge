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

## Why the deploy workflow is manual

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
