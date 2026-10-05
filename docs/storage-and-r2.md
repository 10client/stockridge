# Storage, images and R2

## What exists today

**There is no object storage binding, and no file upload endpoint.** This is
deliberate rather than unfinished, and it matters that the difference is stated
plainly:

| Kind of file | How it is handled now | Where it lives |
|---|---|---|
| Product images | `products.image_url` — a **URL** | Wherever the URL points (a supplier's photo, a cloud drive). The PWA renders it directly and caches it. |
| Business logo | `client_settings.logo_url` — a URL | Same |
| Proof of delivery | `delivery_jobs.proof_of_delivery` — a **data URL** in the row | Inside the database |
| Receipts | Generated as print output and as PDF, client-side | Nowhere — nothing is stored |
| Exports | Generated on request, downloaded by the browser | The user's machine |

A Worker that accepts an uploaded file has to write it somewhere, and there is no
`R2` bucket in `worker/wrangler.toml`. Adding a binding without a plan for
lifecycle, access control and cost would be worse than not having one: a shop
that uploads two hundred product photos a day fills a bucket somebody is paying
for, on an account nobody is watching.

**A data URL in a row is the right answer for a signature** — it is a few
kilobytes, it is delivered atomically with the job it proves, and it can never be
orphaned by a failed upload. It is the wrong answer for a phone photo, which is
2–5 MB before base64 and roughly a third larger afterwards.

## When a client actually needs file storage

The honest trigger is: **more than about fifty product photographs, or proof of
delivery captured as photos rather than a signature.** Below that, URLs and data
URLs are genuinely simpler and genuinely cheaper. Above it, do the following.

### 1. Create the bucket

```bash
npx wrangler r2 bucket create stockridge-media

# A bucket per environment is better, if there is a budget for it
npx wrangler r2 bucket create stockridge-media-staging
```

### 2. Bind it

In `worker/wrangler.toml`, and in each `[env.*]` block that needs it:

```toml
[[r2_buckets]]
binding     = "MEDIA"        # env.MEDIA in the Worker
bucket_name = "stockridge-media"
```

### 3. Decide the access model BEFORE writing any code

This is the step that gets skipped, and it is the one that leaks data.

**A private bucket plus signed URLs is the only safe default.** Product photos
are not secret; a customer's signed credit agreement, a delivery photo showing
the inside of somebody's house, or a scanned ID document absolutely are. A public
bucket (`r2.dev` domain or a custom domain) makes every object world-readable to
anyone who learns the key — and keys are guessable when they are derived from
names.

The pattern that fits this codebase:

```
POST /api/products/:id/image     → validate, store the object, write
                                   products.image_url = '/api/media/<key>'
GET  /api/media/:key             → authenticate, resolve the caller's scope,
                                   check the key belongs to their business,
                                   then redirect to a short-lived signed URL
```

The route must resolve the key against the database, **inside the caller's branch
scope**, before it returns anything. A media route that accepts an arbitrary key
and signs it is a file-disclosure endpoint with an audit log that says everything
is fine.

### 4. Constraints to hold to

| Constraint | Reason |
|---|---|
| Cap the upload size (5 MB) **and** the content type, server-side | A Worker has a request-size limit and a memory limit; the client's check is a convenience, not a control |
| Generate the object key server-side: `<businessId>/<branchId>/<newId()>.<ext>` | A client-supplied key is a path-traversal and a cross-tenant overwrite waiting to happen |
| Store the **key**, not the URL, and build the URL at read time | A signed URL has an expiry, and one written into a row is a broken image tomorrow |
| Delete the object when the row is soft-deleted? **No.** Orphan the object and reap it later | Soft delete exists so a deleted row stays auditable; deleting its evidence on the way out defeats it |
| Set a lifecycle rule on the bucket | "Delete incomplete multipart uploads after 7 days" is free and prevents a quiet bill |
| Put a `Cache-Control: private, max-age=…` on the redirect, not `public` | The signed URL is per-request; a shared cache holding it is a shared cache serving somebody else's photo |

### 5. Cost shape

R2 charges for storage and for operations, and **not for egress** — which is why
it is the right choice here rather than S3-compatible alternatives. A thousand
product photos at 200 KB is 200 MB: comfortably inside the free tier. A thousand
delivery photos a month at 3 MB is 3 GB a month of growth, which is the point at
which somebody should be told the number before it accumulates.

## What not to do

- **Do not put images in D1 as data URLs at photo size.** D1 has a row-size limit
  and a database-size limit, and a database full of base64 photographs backs up
  slowly, costs more, and cannot be served without a query. Signature-sized is
  fine; camera-sized is not.
- **Do not serve media from the Worker as a streaming proxy** unless the object
  is small. A Worker that buffers a 5 MB object for every request is a Worker
  that spends its CPU time on bytes it does not need to see.
- **Do not make the bucket public to avoid writing the auth route.** That is the
  whole decision, and it is one that cannot be undone for data already leaked.
