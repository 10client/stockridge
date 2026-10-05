# Security

## Reporting a vulnerability

Report privately, to the account contact on your StockRidge agreement. Please do
not open a public issue for a security problem.

Include what you did, what happened, and what you expected. An honest report of a
suspected flaw costs far less than a breach, and this product handles a shop's
takings and its staff's attendance records.

## How credentials are handled in this repository

- **No credential is committed.** `.env.deploy`, `.env`, `*.pem`, `.netrc` and
  `.git-credentials` are all in `.gitignore`. The API tokens used to deploy live
  in `.env.deploy` on the machine doing the deploying, or in GitHub repository
  secrets, and nowhere else.
- **No database is committed.** `*.db`, its write-ahead journal, its shared-memory
  file and its JWT file are excluded, along with the whole `.data/` directory.
- The deployment tool prints a generated PIN to the terminal **once**. Only the
  PBKDF2 hash reaches the database.

## Authentication

- PINs are PBKDF2-SHA256, 100,000 iterations, with a 16-byte per-PIN salt and a
  constant-time comparison. The count is capped by the platform: the Cloudflare
  Workers WebCrypto implementation refuses values above 100,000, so a hash
  written above it is verifiable on Node and nowhere else. Do not raise it.
- Failed sign-ins are throttled per username and per IP (`server/lib/loginThrottle.js`).
- One active session per user. A second sign-in retires the first, and the
  retired device is told why rather than failing mysteriously.
- The token carries no authority the database does not confirm: role, branch and
  active status are re-read from the user row on every request.
- A missing user and a wrong PIN take comparable time and return the same
  message, so the endpoint cannot be used to enumerate usernames.

## Authorisation

- Every query that returns trading data is filtered by the caller's branch scope,
  in SQL. No endpoint trusts a branch id supplied by the client as authority.
- The platform administrator (`role = 'ADMIN'`) belongs to no business and no
  branch, and exists to provision and support client businesses.
- Money movements that leave a branch (safe withdrawals, banking, refunds)
  require a reason, an authority level, and leave an audit row.
- Registers that must not be quietly edited are hash-chained
  (`domain/hashChain.js`): a deleted or altered row breaks the chain, and the
  break is detectable by anyone with read access.

## Data

- A client can always export their own data. Read access is deliberately not
  blocked by a suspended subscription.
- Soft deletion throughout (`is_deleted`, `updated_at`), so a deleted row remains
  auditable.
