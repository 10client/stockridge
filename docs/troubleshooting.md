# Troubleshooting

Ordered by how often it happens, not by severity. Start with `/api/diagnose`.

## First move, always

```
https://stockridge.stockridge.workers.dev/api/diagnose
```

It reports the database, the schema, the migrations, whether an administrator
exists, **whether PIN hashing round-trips in this runtime**, and whether the
administrator's sign-in lookup works. Six checks; if one is red, it names the
fault and the others are noise.

| Check red | Meaning | Do this |
|---|---|---|
| database reachable | D1 binding wrong, or the database was deleted | Check `database_id` in `wrangler.toml` against `wrangler d1 list` |
| schema applied | Migrations never ran | `npx wrangler d1 migrations apply stockridge --remote --config worker/wrangler.toml` |
| migrations recorded | Same, from the other side | Same |
| an administrator exists | Seeded with `--skip-seed`, or the row was deactivated | Re-run the deploy without `--skip-seed` |
| PIN hashing round-trip | **A real defect in the platform or the runtime** | Read the `error` field. If it mentions an iteration count, see below. |
| administrator sign-in lookup | The stored hash is malformed, or the row is not there | `--reset-pin`, or check the role |

## The sidebar is empty (or a screen renders nothing)

The app signs in, the header may or may not appear, and there is nothing to click.
The API is fine — every endpoint answers 200. This is a **frontend** fault, and it
is the reason the render check exists.

```
node tools/frontend-smoke.js --url=<origin> --user=admin --pin=<pin> --walk --dump
```

`--walk` opens every destination and names the ones that render nothing; `--dump`
prints the visible screen, the DOM state and the page's own console. Between them
they say *which* screen is dead and *why*, without a browser.

The cause is almost always a name collision in `public/js/state.js`: the session
load assigns raw rows onto the same object that carries the accessors. If a data
field ever shares a name with an accessor, `load()` overwrites the function with
the array and every caller throws "is not a function". `businessRows` /
`branchRows` exist for exactly this reason — do not rename them back.



The single most expensive failure this codebase has had. The schema was right,
the administrator row was right, the hash format was right, and every sign-in
answered `401 BAD_CREDENTIALS`. All 251 tests passed, because they run on Node.

**Cause:** the Cloudflare Workers WebCrypto implementation refuses a PBKDF2
iteration count above **100,000** — and it refuses by throwing, which `verifyPin`
converts to `false`. Node computes 120,000 iteration hashes happily. So the Node
backend wrote a hash the deployed Worker could never verify.

**Check:** `/api/diagnose` → the `PIN hashing round-trip` check. It exercises the
mechanism directly. The Worker also logs this, look for it in `wrangler tail`:

```
[crypto] stored PIN hash uses 120000 PBKDF2 iterations, above this runtime's
maximum of 100000. It cannot be verified here. Re-set this user's PIN with a
hash written by the running backend.
```

**Fix:** `PBKDF2_MAX_ITERATIONS` in `domain/crypto.js` is a platform ceiling, not
a preference — it must stay at or below 100,000. Then replace the stored hash,
because the old one is unverifiable:

```bash
node tools/deploy-cloudflare.js --reset-pin
```

## "You have been signed out because this account signed in somewhere else"

Not a fault. One active session per user is enforced, and the message names the
supersession deliberately — a cashier signed out at 8am by somebody logging in as
them at 7:55am is worth noticing.

If it happens to an owner who never shares their PIN, **that is a security event,
not a support ticket**: somebody knows their PIN. Change it, and read the audit
log.

## A store's data is missing, or a manager sees another branch

Every scope is derived from `branch_id` on the user row, re-read on every request.
Two things follow:

- **Expected behaviour:** moving a user to another branch changes what they see on
  their *next request*, not at token expiry.
- **A genuine fault** looks like a *missing* branch filter, not an extra one.
  Check the query for `scopeFilter(scope, …)` — if it is absent, the route is
  unscoped. `test/e2e/frontend-routes.test.js` and the scope tests cover the
  routes that exist; a new route is the risk.

## The app shows an old version

The service worker serves a cached shell and updates in the background.

1. Hard-reload once (the new version is usually already installed).
2. If that does not do it, the `BUILD` stamp did not change. `public/js/app.js`
   and `public/sw.js` must carry the **same** `BUILD` string — a mismatch means
   clients keep serving the old precache while believing they are current.
3. Never diagnose this by telling a shop to clear site data: that deletes queued
   offline sales. See the offline section below.

## "It says offline but the internet is fine"

Check whether the device is actually reaching the deployment, in the browser:

```
https://stockridge.stockridge.workers.dev/api/health
```

- **200** → the device's network is fine and the *app* thinks it is offline;
  suspect a stale service worker or a failed installation.
- **Nothing** → DNS, a captive portal, or a genuinely down link.

An offline PWA showing offline when it is online is almost always the service
worker, and the fix is the `BUILD` stamp above.

## Queued sales never post

The offline queue holds writes with **idempotency keys**, so a sale that posts
twice is applied once — retrying is always safe and is what the client does
automatically.

When a write is rejected rather than lost, it lands as a **sync conflict** for a
human decision (Sync screen): `SERVER_KEPT`, `DEVICE_REQUEUED`, or `MERGED`. A
conflict is not an error; it is the system refusing to guess which of two
versions of a sale is real.

If the Sync screen shows a conflict that keeps reappearing, the underlying
problem is a validation failure on the server (a deleted product, a price
outside the allowed range, a branch the user no longer belongs to). Read the
server's message — it names the field.

## "table businesses already exists" while restoring a backup

A **full** export (`d1 export` without `--no-schema`) begins with `CREATE TABLE`.
Restoring it into a database that already has the schema fails at the **first**
statement — so the error names `businesses`, not anything suspicious you were
looking for.

Either restore into an empty database, or take the data-only export:

```bash
npx wrangler d1 export stockridge --remote --config worker/wrangler.toml \
  --no-schema --output=data.sql
```

## Deploy fails at the build step

Two classes, and the message distinguishes them.

| Message | Cause | Fix |
|---|---|---|
| `Your worker has no default export` | The Worker entry has `module.exports` but no `export default`, so wrangler read it as a legacy service-worker script and then refused every `node:*` import | The entry must be an ES module (`.mjs`, or `type: module`) with `export default worker` |
| `Unexpected external import of node:…` | Same root cause | Same |
| Cannot resolve a relative import | A file was renamed or moved | Check the path; `node --check` will not catch a *missing* file, only a broken one |
| A binding is missing at runtime | Declared in one `[env.*]` block and not another | Compare the blocks in `worker/wrangler.toml` |

Reproduce any of these without credentials in about fifteen seconds:

```bash
npx wrangler deploy --dry-run --config worker/wrangler.toml
```

## Deploy succeeded but the fix is not live

**This is usually propagation, not failure.** A new Worker version takes up to
tens of seconds to reach every edge location, and an early request can be served
by the previous version still warm.

The deploy tool retries for two minutes for exactly this reason. If you are
checking by hand, `curl -s ".../api/diagnose?cb=$RANDOM"`. If it is still stale
after two minutes, check which version is actually live:

```bash
npx wrangler deployments list --config worker/wrangler.toml
```

## `wrangler` will not run

`wrangler 4` requires **Node 22 or newer**. It does not warn; it refuses.

```bash
node --version      # must be v22+
```

If the machine has Node 20 (which is fine for the Node backend), install Node 22
and prepend it to `PATH` for wrangler commands. This workspace's own history is
the example: `node` is v20.20.2 and wrangler is called with
`PATH=/home/user/.local/node-v22.11.0-linux-x64/bin:$PATH`.

Related, and confusing the first time: **`wrangler@3` rejects
`assets.run_worker_first = ["/api/*"]`** and wants a boolean instead. This project
needs the array form so that API paths reach the Worker rather than the asset
fallback. Pin wrangler 4 and Node 22.

## The API token is rejected by `/user/tokens/verify`

Expected for some tokens, and not fatal. An account-scoped API token can be
refused by that endpoint while every Workers and D1 call succeeds. `/user/tokens/verify`
answers a question the deployment does not need answered.

The deploy tool therefore calls `/accounts` instead. If that works, the token is
fine, whoever it belongs to.

## Tests fail locally and passed a moment ago

If the count is **117/127 instead of 260/260**, `node_modules` is missing:
`Cannot find module 'better-sqlite3'`. Every database-backed test file fails while
the pure-domain tests and all three audits pass — which reads exactly like a code
regression and is not one.

```bash
npm install && npm test
```

This workspace in particular does not preserve `node_modules` across a session
boundary, so it happens after every pause. Recorded in
[../STATUS.md](../STATUS.md) so it stops costing time.

## Something is wrong and none of this matches

Collect, in this order, and send it as one message rather than five:

1. The full JSON from `/api/diagnose`
2. The result of `/api/health/ready` (it names its own problems, and
   `awaiting_first_business` is not one)
3. The exact text of the error the user saw
4. What they were doing immediately before
5. Whether they were offline when they did it

Points 4 and 5 are the ones that get left out and the ones that usually identify
the fault: an offline write that queued, a branch the user was moved out of, or a
conflict awaiting a decision.
