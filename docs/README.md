# StockRidge documentation

Operational documentation for running, deploying and handing over StockRidge.
Every command in here has been run; every number in here is read from the code.

| Document | Read it when |
|---|---|
| [deployment.md](deployment.md) | Taking a fresh account to a running deployment, or shipping a change |
| [d1-operations.md](d1-operations.md) | Reading the production database, applying migrations, taking a backup |
| [storage-and-r2.md](storage-and-r2.md) | A client asks for product photos, receipt scans or signatures as files |
| [ci-cd.md](ci-cd.md) | Wiring GitHub Actions, or understanding why a build failed |
| [client-handover.md](client-handover.md) | Putting this in front of a real business on day one |
| [troubleshooting.md](troubleshooting.md) | Something is wrong and the shop is open |
| [../STATUS.md](../STATUS.md) | You want the honest build record — what is proven and what is not |

## The ten facts that explain everything else

1. **There is one implementation of the API.** `server/routes/*` holds 166 routes.
   Node and Cloudflare Workers both run them; only the storage adapter differs
   (`server/lib/db.js` for SQLite, `worker/src/d1.js` for D1).
2. **There is one schema.** `schema/migrations/*.sql` is applied verbatim by both
   runtimes — 76 tables, 22 views, 2 migrations. There is no second set.
3. **The Worker serves the PWA too**, from its assets binding. There is no
   separate Pages project and no second deploy.
4. **A fresh deployment contains one administrator and nothing else.** The
   client's first act is to create *their* business; provisioning builds the chart
   of accounts, categories, price lists and starter catalogue from that.
5. **Two ways to serve: Node (a shop's own server) and Workers (the cloud).**
   Both are supported and both are tested.
6. **Offline first.** The PWA precaches its shell, queues writes with idempotency
   keys, and reconciles with last-writer-wins while capturing conflicts for a
   human decision.
7. **Timezone is West Africa Time everywhere**, including "today" on a dashboard
   and the day a sale belongs to. The database stores UTC.
8. **Money is in kobo** (integers) in the database, formatted at the edges.
9. **PINs are PBKDF2-SHA256 at 100,000 iterations** — a platform ceiling, not a
   preference. See [SECURITY.md](../SECURITY.md).
10. **Every mutable row is soft-deleted** (`is_deleted`, `updated_at`), and the
    registers that must not be quietly edited are hash-chained.
