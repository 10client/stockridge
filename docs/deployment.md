# Deployment

How to take a Cloudflare account with nothing in it to a running StockRidge, and
how to ship a change afterwards without breaking a shop that is open.

## What you need

| Thing | Detail |
|---|---|
| Node | **22 or newer.** wrangler 4 refuses anything below 22. Node 20 runs the Node backend fine — the two backends have different minimums, and that is not a mistake. |
| A Cloudflare account | The free plan runs this. D1's free tier covers a single-branch shop comfortably; see [d1-operations.md](d1-operations.md) for the limits that matter. |
| A Cloudflare API token | Account · **Workers Scripts · Edit** and Account · **D1 · Edit**. Create at `dash.cloudflare.com/profile/api-tokens`. Do **not** use the Global API Key. |
| `.env.deploy` | Copy `.env.deploy.example`. It is gitignored and must never be committed. |

Note: `GET /user/tokens/verify` rejects account-scoped tokens that work perfectly
well for Workers and D1, so the deploy tool does not treat that endpoint as
authoritative — it calls `/accounts` instead, which is the permission the
deployment actually needs.

## The one command

```bash
node tools/deploy-cloudflare.js
```

Seven steps, every one idempotent, so running it twice is safe and running it
after a failure resumes rather than restarts:

| Step | What it does | Why it is safe to repeat |
|---|---|---|
| 1 | Verify the token, resolve the account id | Read-only |
| 2 | Create the D1 database if it does not exist | Looks it up by name first |
| 3 | Write the database id into `worker/wrangler.toml` | Rewrites the three bindings with the same value |
| 4 | Apply `schema/migrations/*.sql` | D1 tracks what it has applied |
| 5 | Seed **one administrator** | `INSERT OR IGNORE`; never resets a changed PIN |
| 6 | Set the `JWT_SECRET` Worker secret | Overwrites with a generated value |
| 7 | Deploy the Worker and smoke-test it | An update, not a duplicate |

Step 7 is the point of the whole tool. It calls `/api/health`,
`/api/health/ready`, `/api/diagnose`, fetches the PWA and the service worker, and
**signs in as the administrator for real**. A deploy that reports success and
leaves an administrator who cannot sign in is worse than one that fails loudly,
and the only way to tell the difference is to sign in.

### Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Every step except the deploy itself |
| `--skip-seed` | Do not touch the administrator row at all |
| `--reset-pin` | **Overwrite** the administrator's PIN hash |
| `--pin=48213` | Choose the PIN rather than generating one |

Do not pass `--reset-pin` casually. The seed is `INSERT OR IGNORE`, so a normal
deploy **never** resets a PIN the client has already changed, and the summary says
plainly that the existing PIN is unchanged rather than printing one that does not
work. `--reset-pin` is for two situations only: the PIN is genuinely lost and
there is no other administrator, or the stored hash was written by a runtime this
deployment cannot verify.

### What it prints

```
Deployment summary
  account       : <account id>
  D1 database   : stockridge (<uuid>)
  Worker        : https://stockridge.stockridge.workers.dev
  readiness     : awaiting_first_business
  administrator : admin
  PIN           : 48213

  This PIN is shown once. Only its hash is stored.
```

**Write that PIN down before you close the terminal.** Only the PBKDF2 hash
reaches the database; there is no recovery, only `--reset-pin`.

## The Node backend (a shop's own server)

For a business that wants its data on its own premises, or for development:

```bash
npm install
npm run db:migrate                 # schema/migrations/*.sql
npm run db:seed                    # OPTIONAL demo business — development only
PORT=8787 npm start                # http://localhost:8787
```

The server stores its database at `.data/stockridge.db` and derives a JWT secret,
persisting it beside the database at `.data/stockridge.db.jwt`, so tokens survive
a restart on a machine nobody configured. Set `STOCKRIDGE_DB` to move the
database; the secret follows it.

`npm run db:seed` creates a demo business with sales, staff and stock. **A client
deployment must never be seeded with it** — the handover state is one
administrator, and the client's own provisioning flow does the rest. See
[client-handover.md](client-handover.md).

## Shipping a change afterwards

```bash
npm run verify          # three static audits, then 260 tests
node tools/deploy-cloudflare.js
```

`verify` is the gate. It runs `db:audit` (placeholder/value mismatches,
arbitrary-row reads), `names:audit` (undefined or unimported names — the bug class
that has bitten this codebase six times) and `args:audit` (service functions
called with keys their callee ignores), then the test suite.

Two warnings are worth understanding before you deploy:

- **`the Worker build is the second gate`.** `wrangler deploy --dry-run` builds
  the bundle and catches a whole class of failure the tests cannot see — a module
  format wrangler refuses, an import that does not resolve, a binding that does
  not exist. CI runs it on every push. Run it locally if CI is unavailable:
  `npx wrangler deploy --dry-run --config worker/wrangler.toml`.
- **A deployment takes a minute to reach every edge location.** The smoke test
  retries for up to two minutes before it reports a problem, because a check run
  seconds after `deploy` can be answered by the *previous* version still warm in
  the isolate serving your machine.

## Rollback

The Worker is versioned, so a bad deploy is reversible without touching the
database:

```bash
npx wrangler deployments list --config worker/wrangler.toml
npx wrangler rollback <version-id> --config worker/wrangler.toml
```

**A rollback does not roll back the schema.** If a release added a migration, the
previous version is running against the newer schema. Keep migrations backward
compatible for one release — add columns rather than rename them, and stop
reading a column one release before dropping it — or rollback will not save you.

## Environments

Each environment in `worker/wrangler.toml` is a separate Worker with its own D1
database, and `--env` is what selects one. **Every environment has its own
database on purpose** — an environment that shares production's data is not a
separate environment, it is production with a second URL, and the first thing
anybody tries in it is something they would not try in production.

| `--env` | Worker | URL | Database |
|---|---|---|---|
| *(none)* | `stockridge` | https://stockridge.stockridge.workers.dev | `stockridge` |
| `sample` | `sample` | https://sample.stockridge.workers.dev | `stockridge-sample` |
| `staging` | `stockridge-staging` | https://stockridge-staging.stockridge.workers.dev | `stockridge-staging` |

```bash
node tools/deploy-cloudflare.js --env=sample --pin=48213
```

The tool creates the database if it does not exist, writes its id into the
matching `[[env.<name>.d1_databases]]` block, and reports which other
environments it left alone. It only ever rewrites the section for the
environment it is deploying to.

**`sample` is the one to show a prospective client.** It holds one administrator
and nothing else, so their first act is to create their own business and watch
provisioning build a chart of accounts, categories, price lists and a starter
catalogue for the vertical they choose.

### When every environment is admin-only

All three currently hold exactly one administrator, one withholding schedule and
one settings row. `readiness` reports `awaiting_first_business` on each, which is
the correct handover state, not a fault.

To put a deployment back into that state after somebody has tried it, delete the
database and deploy again — the tool recreates it, migrates it and seeds the
administrator:

```bash
# get the uuid: npx wrangler d1 list
curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/<uuid>"
node tools/deploy-cloudflare.js --env=sample --pin=48213
```

## Environments and secrets, in one table

| Name | Where | What |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `.env.deploy`, or GitHub secret | Deploys the Worker and D1 |
| `CLOUDFLARE_ACCOUNT_ID` | `.env.deploy` | Optional; resolved from the token |
| `JWT_SECRET` | **Worker secret** | Signs session tokens. A Worker secret, never a var: a var is visible in the dashboard and in the bundle. |
| `STOCKRIDGE_JWT_SECRET` | `.env.deploy` | Optional. Set it to keep sessions valid across an account migration; otherwise one is generated per deploy. |
| `STOCKRIDGE_ADMIN_USERNAME` | `.env.deploy` | The seeded administrator's username, `admin` by default |
| `STOCKRIDGE_ADMIN_PIN` | `.env.deploy` | Optional; a five-digit PIN is generated otherwise |
| `ENVIRONMENT`, `DB_NAME` | `wrangler.toml` `[vars]` | Non-secret; readable in the bundle |
| `STOCKRIDGE_DB` | shell | Node backend only — where the SQLite file lives |

If `JWT_SECRET` is missing, the Worker still signs with a value derived from the
database id, which is stable across deploys and invisible to the client, and adds
an `X-JWT-Secret: derived-not-configured` header to `/api/diagnose` and logs a
warning. Signing out a shop floor because a deploy forgot an environment variable
is worse than a secret that is merely adequate — but it is not good enough to be
silent about either, which is why the header says so.
