# StockRidge

**Multi-branch, multi-business inventory, POS and back-office platform for the
Nigerian retail and wholesale market.** Built for appliance and gadget shops,
furniture showrooms, wholesale and general merchandise dealers, and building
materials and hardware yards — from the same codebase, configured per business.

StockRidge is an **offline-first PWA**: an SQLite database on the server or in
the browser's device storage, and Cloudflare D1 online. A branch keeps selling
when the network drops, and reconciles when it returns.

Live deployment: **https://stockridge.stockridge.workers.dev**

---

## What it does

| Area | Detail |
|---|---|
| **Trading** | POS with barcode and variant picking, wholesale price tiers, customer classes, promotions, vouchers, discounts with authority limits |
| **Stock** | Batches with landed cost, transfers between branches, stocktakes that freeze the system quantity, adjustments with approval, reorder alerts, serial numbers |
| **Multi-branch / multi-business** | One owner can hold several businesses and several branches; every row is scoped by `branch_id`, which is the single source of scoping truth |
| **Nigeria-specific** | VAT 7.5% extracted from inclusive prices, the 2024 Withholding Regulations held as editable data, West Africa Time bucketing throughout, geofenced attendance, NUBAN validation |
| **Credit & instalments** | Debtor ledger, credit limits, Ajo and instalment plans with schedules and part-payments, layaway with item holds |
| **After sales** | Serial-tracked warranty claims, product recalls, delivery jobs with vehicles and zones, installation jobs |
| **Money** | Cashbook per branch, till sessions with variance reasons, branch safe with deposits and banking, expenses with approval, double-entry general ledger |
| **Control** | Hash-chained append-only registers, audit log, idempotency keys on every write, LWW sync with conflict capture, login throttling, one open till/stocktake/plan per branch |

## Two backends, one route table

The unusual part of this codebase, and the reason it stays correct:

```
                     server/routes/*        ← the only implementation of any endpoint
                            │
        server/lib/http.js ─┴─ createApp() + buildRoutes()
             ┌──────────────┴───────────────┐
    server/app.js                    worker/src/index.mjs
    Node + better-sqlite3            Cloudflare Worker + D1
    (a shop's own server)            (stockridge.stockridge.workers.dev)
```

`buildRoutes()` registers **166 routes** against an abstract storage interface.
Node satisfies it with `better-sqlite3`; the Worker satisfies it with
`worker/src/d1.js`. There is no second implementation of any route, service,
query or business rule — no drift, because there is nothing to drift from.

The same two `.sql` files in `schema/migrations/` are applied verbatim by both
runtimes: **76 tables, 22 views**.

## Verticals

Chosen when the client creates their business; each brings its own categories,
units of measure, compliance requirements (SONCAP/SON) and warranty rules, plus a
starter catalogue and chart of accounts.

| Code | Vertical |
|---|---|
| `ELECTRONICS` | Electronics, Appliances & Gadgets |
| `FURNITURE` | Furniture & Home Furnishings |
| `WHOLESALE_RETAIL` | Wholesale & Retail General Merchandise |
| `BUILDING_MATERIALS` | Building Materials & Hardware |
| `GENERAL_RETAIL` | General Retail (fully configurable) |

---

## Local development (the Node backend)

Requires **Node 20.11 or newer**.

```bash
npm install
npm run db:migrate          # applies schema/migrations/*.sql
npm run db:seed             # OPTIONAL: a demo business, for development only
npm start                   # http://localhost:8787
```

`npm run db:seed` builds a full demo business with sample sales. **It is for
development.** A client deployment is handed over with one administrator and
nothing else, and the client's own provisioning flow creates the rest.

```bash
npm test                    # 260 tests: unit, integration, end-to-end
npm run verify              # the three static audits, then the tests
npm run db:audit            # placeholder/value mismatches, arbitrary-row reads
npm run names:audit         # undefined or unimported names
npm run args:audit          # service functions called with keys they ignore
```

## Deploying to Cloudflare

Requires **Node 22 or newer** (wrangler 4 refuses older) and a Cloudflare API
token in `.env.deploy` — see `.env.deploy.example` and copy it.

```bash
node tools/deploy-cloudflare.js
```

One command, seven steps, idempotent: verify the token and resolve the account →
create the D1 database if it does not exist → write its id into
`worker/wrangler.toml` → apply the migrations → seed **one administrator** →
set the `JWT_SECRET` → deploy the Worker (which serves both the API and the PWA)
→ smoke-test the result, including a real sign-in.

Useful flags:

| Flag | Effect |
|---|---|
| `--dry-run` | Everything except the deploy itself |
| `--skip-seed` | Never touch the administrator row |
| `--reset-pin` | **Overwrite** the administrator's PIN hash (see below) |
| `--pin=48213` | Choose the PIN instead of generating one |

### The first run

A deployment starts with **one administrator, one withholding schedule, and no
business at all.** That is deliberate: the client's first act is to describe
*their* business, and provisioning builds the chart of accounts, product
categories, customer classes, price lists and a starter catalogue for the
vertical they choose.

```
sign in as the administrator
  → Businesses → Create a business → choose the vertical
  → Users → create an OWNER for that business
  → hand over the owner's PIN
```

`GET /api/diagnose` reports whether the deployment is correctly wired, and
`GET /api/health/ready` reports whether it is ready to trade. On a fresh
deployment readiness answers `awaiting_first_business`, which is correct and not
a fault.

### Renewing the administrator's PIN

The seed is `INSERT OR IGNORE`: re-running the deploy **never** resets a PIN the
client has already changed, and the deploy prints the existing PIN as unchanged.
To deliberately replace it:

```bash
node tools/deploy-cloudflare.js --reset-pin
```

## Repository layout

```
domain/           15 pure modules — money, tax, time, credit, pricing, access,
                  validation. No database, no framework, no Node built-ins.
server/
  lib/            storage interface, HTTP router, responses, audit, throttling
  middleware/     authentication, scope resolution
  services/       sales completion, general ledger, provisioning
  routes/         17 route modules — the whole API
  app.js          the Node entry point (static files, CORS, SPA fallback)
worker/
  src/index.mjs   the Cloudflare entry point
  src/d1.js       the D1 storage adapter
  wrangler.toml   bindings, migrations, cron, environments
schema/migrations/  applied verbatim by BOTH backends
public/           the PWA — 23 views, service worker, offline queue
test/             unit, integration and end-to-end suites
tools/            migrate, seed, deploy, and the three static audits
```

## Security

- PINs are hashed with PBKDF2-SHA256, 100,000 iterations, per-PIN salt, constant
  time comparison. **100,000 is a platform ceiling, not a preference** — the
  Cloudflare Workers WebCrypto implementation refuses anything above it, and a
  hash written above it can only be verified on Node. See `domain/crypto.js`.
- Sessions are 12 hours (a shop day), one active session per user, revoked on
  sign-out and revalidated against the live user row on every request — so
  deactivating a user or moving their branch takes effect on their next request.
- Every store's scope comes from `branch_id`, applied in the query, never by the
  client.
- Report a problem per `SECURITY.md`.

## Licence

Proprietary. © StockRidge. All rights reserved.
