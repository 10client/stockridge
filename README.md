# StockRidge — Production Multi-Branch Retail & Inventory Platform

StockRidge is a modern, high-integrity multi-business, multi-branch retail and ERP platform tailored for Nigerian commerce, wholesale, and multi-channel retail operations. Built for zero-loss financial and inventory reconciliation, StockRidge combines strict double-entry general ledger accounting, cryptographically tamper-evident hash-chained audit registers, robust offline POS sync, and native multi-vertical business configuration (Electronics, Appliances, Furniture, Wholesale & Retail, Building Materials).

---

## 🏛️ Architecture & Clean Decoupling

StockRidge is structured with strict separation of concerns, supporting dual deployment backends (Node.js VPS / SQLite WASM and Cloudflare Workers / D1):

```
├── domain/                  # Pure business domain logic (zero side-effects)
│   ├── audit.js             # Audit logging and verification
│   ├── compliance.js        # Statutory conformity & certificate validation
│   ├── creditPlans.js       # Customer credit assessment & debt ageing
│   ├── fulfilment.js        # Delivery quotation, dispatch & logistics
│   ├── identity.js          # Authentication, PIN policy & JWT tokens
│   ├── money.js             # Kobo-integer arithmetic, largest-remainder allocation
│   ├── payments.js          # Tender resolution, POS fee calculations, till reconciliation
│   ├── pricing.js           # Multi-tier pricing engine, promotions, price floor rules
│   ├── roles.js             # RBAC and role hierarchy definitions
│   ├── stockMovement.js     # Stock allocation (FIFO/FEFO/LIFO), batch tracking
│   ├── tax.js               # VAT extraction & WHT calculation (2024 Regulations)
│   ├── uom.js               # Unit of Measure ladder (Unit/Pack/Carton/Pallet)
│   ├── verticals.js         # Multi-vertical data profiles & restriction cascades
│   └── warranty.js          # Serial number tracking & warranty claims management
│
├── server/                  # Node.js backend server & API adapter
│   ├── app.js               # Server application entrypoint
│   ├── db/                  # SQLite adapter, migrations (0001-0009), seeders
│   ├── lib/                 # Auth, tenancy scoping, route utilities
│   ├── routes/              # Modular Express/REST routing layer
│   └── services/            # Backend orchestration services
│
├── shared/                  # Isomorphic business services and domain facades
│   ├── lib/                 # Domain modules shared across Node & Workers
│   └── services/            # Domain services (sales, gl, stock, audit, core)
│
├── worker/                  # Cloudflare Workers & D1 deployment
│   ├── src/                 # Worker entrypoint, router, D1 adapter, maintenance crons
│   └── wrangler.toml        # Cloudflare Workers configuration
│
├── public/                  # Lightweight PWA frontend (HTML5, Vanilla JS, CSS3, Service Worker)
├── test/                    # Full audit test suites
│   ├── audit.domain.js      # Pure domain calculation & validation audit (288 tests)
│   └── audit.flows.js       # End-to-end multi-tenant transactional flow audit (130 tests)
├── tools/                   # Database migration & seeding CLI tools
└── wrangler.toml            # Root Cloudflare Wrangler configuration
```

---

## 🚀 Key Functional Capabilities

1. **Exact-Footing Kobo Accounting**:
   - Zero floating-point rounding drift. Every monetary value is calculated in Kobo integers.
   - Value Added Tax (VAT 7.5%) is extracted cleanly from gross retail price rather than added on top.
   - Fully automated double-entry General Ledger (GL) journal posting on every sale, refund, transfer, and payment.

2. **Cryptographic Tamper-Evident Hash Registers**:
   - Every high-value sale, age-restricted purchase, and sensitive movement extends a cryptographic SHA-256 hash chain per branch per day.
   - Any retroactive mutation or row deletion breaks the chain verifiably at the exact tampering index.

3. **Multi-Vertical Dynamic Profiling**:
   - Data-driven vertical configurations without conditional code bloat:
     - **Electronics & Appliances**: Serial number capture, IMEI tracking, 24-month warranties, SONCAP.
     - **Furniture**: Assembly fees, bulky delivery surcharges, installation services.
     - **Wholesale & Supermarket**: Expiry date tracking (FEFO), carton/pack/pallet UOM ladder, NAFDAC.
     - **Building Materials**: Fractional unit dimensions (tonnes, metres), two-man logistics.

4. **Honest Credit & Instalment Mechanics**:
   - 4-gate credit limit evaluation preventing bad debt accumulation.
   - Layaway holds reserve physical batch inventory without moving stock off premises.
   - Largest-remainder instalment schedules guaranteeing deposit + instalments foot to the kobo.

5. **Multi-Tenant Tenancy Scoping**:
   - Pinned branch managers cannot query or reparent data across unauthorized branches or corporate entities.

---

## 🧪 Testing & Verification

StockRidge features a 418-test automated audit suite verifying domain calculations, transactional invariants, and report view integrity:

```bash
# Run complete test suite (Domain Core + Flow Audit)
npm test

# Run individual test harnesses
npm run test:domain
npm run test:flows
```

---

## 🛠️ Local Development & Operations

### Migration & Seeding CLI

```bash
# Apply pending migrations
npm run migrate

# Reset and re-apply all migrations
node tools/migrate.js --reset

# Seed demonstration database with realistic Nigerian market data
npm run seed
```

---

## ☁️ Cloudflare Workers & D1 Deployment

StockRidge deploys to Cloudflare's global edge network backed by Cloudflare D1 distributed SQLite and R2 storage:

1. Authenticate with Cloudflare Wrangler:
   ```bash
   npx wrangler login
   ```
2. Initialize and migrate Cloudflare D1:
   ```bash
   npx wrangler d1 create stockridge
   npx wrangler d1 migrations apply stockridge --remote
   ```
3. Deploy the application:
   ```bash
   npm run deploy
   ```
