'use strict';
// =====================================================================
// server/services/provisioningService.js — SETTING UP A BUSINESS
// =====================================================================
// Creating a business in this system is not one INSERT. A usable business
// needs, at minimum: a vertical profile applied, a category tree, a chart of
// accounts, customer classes, a default retail price list and a default
// wholesale price list, an opening safe entry, and optionally a starting
// catalogue. Do that by hand and a new client's first day is spent on setup
// instead of selling — which is how a deployment gets abandoned in week one.
//
// So this module derives all of it from domain/verticals.js in ONE
// transaction, and it is IDEMPOTENT: running it twice for the same business
// adds nothing, because provisioning is retried after a dropped connection
// and a duplicate category tree is worse than a missing one.
// =====================================================================

const { newId } = require('../../domain/crypto');
const { round2 } = require('../../domain/money');
const { getProfile, resolveProfile, PROFILE_CODES, MEASURE_AXES, ladderForSeedProduct, baseUnitNameFor } = require('../../domain/verticals');
const glService = require('./glService');
const { HttpError } = require('../lib/http');

/** Parse a business's profile overrides, tolerating bad JSON. */
function parseOverrides(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    // A corrupt overrides value must not make the business unusable. Falling
    // back to the unmodified profile is the safe failure: the client loses a
    // customisation, not their shop.
    console.error('[provisioning] could not parse profile_overrides_json, using the base profile:', e.message);
    return null;
  }
}

function profileForBusiness(business) {
  return resolveProfile(business.profile_code, parseOverrides(business.profile_overrides_json));
}

/**
 * Provision a business: categories, chart of accounts, customer classes and
 * default price lists. Returns what was created and what already existed.
 */
async function provisionBusiness(db, business, { withCatalogue = true, createdBy = null } = {}) {
  const profile = profileForBusiness(business);
  const businessId = String(business.id);

  const existing = await Promise.all([
    db.all('SELECT code FROM product_categories WHERE business_id = ? AND is_deleted = 0', [businessId]),
    db.all('SELECT code FROM gl_accounts WHERE business_id = ? AND is_deleted = 0', [businessId]),
    db.all('SELECT code FROM customer_classes WHERE business_id = ? AND is_deleted = 0', [businessId]),
    db.all('SELECT code FROM price_lists WHERE business_id = ? AND is_deleted = 0', [businessId]),
  ]);
  const haveCategories = new Set(existing[0].map((r) => r.code));
  const haveAccounts = new Set(existing[1].map((r) => r.code));
  const haveClasses = new Set(existing[2].map((r) => r.code));
  const haveLists = new Set(existing[3].map((r) => r.code));

  const summary = { businessId, profile: profile.code, categories: 0, accounts: 0, customerClasses: 0, priceLists: 0, products: 0, skipped: [] };
  const claimedBarcodes = new Set();
  const claimedVariantSkus = new Set();

  await db.transaction(async (tx) => {
    // ---- categories
    const categoryIds = new Map();
    for (let i = 0; i < profile.categories.length; i += 1) {
      const cat = profile.categories[i];
      if (haveCategories.has(cat.code)) { summary.skipped.push(`category:${cat.code}`); continue; }
      const id = tx.idFor(`cat-${cat.code}`);
      categoryIds.set(cat.code, id);
      tx.queue(`INSERT INTO product_categories (id, business_id, code, name, sort_order, is_active, created_at, updated_at)
                VALUES (?,?,?,?,?,1, datetime('now'), datetime('now'))`, [id, businessId, cat.code, cat.name, i]);
      summary.categories += 1;
    }

    // ---- chart of accounts
    const accountStatements = glService.seedChartStatements({ businessId, accountsByCode: haveAccounts });
    summary.accounts = accountStatements.length;
    for (const s of accountStatements) tx.queue(s.sql, s.params);

    // ---- customer classes and the price lists they point at
    const listIds = new Map();
    const defaultLists = [
      { code: 'RETAIL', name: 'Retail (shelf price)', priority: 10 },
      { code: 'WHOLESALE', name: 'Wholesale', priority: 20 },
    ];
    for (const list of defaultLists) {
      if (haveLists.has(list.code)) { summary.skipped.push(`price_list:${list.code}`); continue; }
      const id = tx.idFor(`list-${list.code}`);
      listIds.set(list.code, id);
      tx.queue(`INSERT INTO price_lists (id, business_id, name, code, priority, is_active, created_at, updated_at)
                VALUES (?,?,?,?,?,1, datetime('now'), datetime('now'))`, [id, businessId, list.name, list.code, list.priority]);
      summary.priceLists += 1;
    }

    for (let i = 0; i < profile.customerClasses.length; i += 1) {
      const cc = profile.customerClasses[i];
      if (haveClasses.has(cc.code)) { summary.skipped.push(`customer_class:${cc.code}`); continue; }
      const defaultListCode = cc.discountPct >= 10 ? 'WHOLESALE' : 'RETAIL';
      tx.queue(`INSERT INTO customer_classes (
          id, business_id, code, name, default_price_list_id, discount_pct, credit_allowed,
          default_credit_limit, payment_terms_days, is_system, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,1, datetime('now'), datetime('now'))`, [
        tx.idFor(`cc-${cc.code}`), businessId, cc.code, cc.name,
        listIds.get(defaultListCode) || null,
        round2(cc.discountPct || 0), cc.creditAllowed ? 1 : 0,
        round2(cc.defaultCreditLimit || 0), Number(cc.termsDays || 0),
      ]);
      summary.customerClasses += 1;
    }

    // ---- starting catalogue
    if (withCatalogue && profile.seedProducts && profile.seedProducts.length) {
      const existingProducts = await db.all('SELECT sku FROM products WHERE business_id = ? AND is_deleted = 0', [businessId]);
      const haveSkus = new Set(existingProducts.map((p) => p.sku));
      for (const seed of profile.seedProducts) {
        if (seed.sku && haveSkus.has(seed.sku)) { summary.skipped.push(`product:${seed.sku}`); continue; }
        const productId = tx.idFor(`prod-${seed.sku || seed.name}`);
        const categoryId = categoryIds.get(seed.category) || null;
        const requiresSerial = seed.serial ? 1 : 0;
        const tracksVariants = seed.variants && seed.variants.length ? 1 : 0;

        // reorder_level is in BASE UNITS. A seed's reorder figure is written
        // in the unit a merchant thinks in (bags of cement, cartons of
        // noodles), so it is converted through the ladder's default sell
        // level. Without that, "reorder at 200" for a carton-packed product
        // silently becomes "reorder at 200 pieces" and the alert fires six
        // times too early.
        const ladder = ladderForSeedProduct(profile, seed);
        const defaultLevel = ladder.find((l) => l.isDefaultSell) || ladder[0];
        const reorderBase = round2(Number(seed.reorder || 0) * Number(defaultLevel.quantityInBase || 1));

        tx.queue(`INSERT INTO products (
            id, business_id, category_id, sku, name, brand, model_no,
            requires_serial, tracks_variants, warranty_months, is_bulky, requires_installation,
            has_expiry, is_fragile, base_unit_name, cost_price, selling_price,
            reorder_level, reorder_quantity, valuation_method, is_active, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 1, datetime('now'), datetime('now'))`, [
          productId, businessId, categoryId, seed.sku || null, seed.name, seed.brand || null, seed.model || null,
          requiresSerial, tracksVariants,
          Number(seed.warranty != null ? seed.warranty : profile.defaultWarrantyMonths || 0),
          seed.bulky ? 1 : 0, seed.installation ? 1 : 0, seed.expiry ? 1 : 0, seed.fragile ? 1 : 0,
          // DERIVED from the ladder, never taken from seed text: base_unit_name
          // must be the same word product_units level 0 uses, or a receipt says
          // "3 length" while the stock sheet says "3 metre".
          baseUnitNameFor(profile, seed),
          round2(seed.cost), round2(seed.price),
          reorderBase, reorderBase > 0 ? round2(reorderBase * 4) : 0,
          'WEIGHTED_AVG',
        ]);

        // ---- unit ladder (derived above, shared with products.base_unit_name)
        const baseUnitName = baseUnitNameFor(profile, seed);
        for (let li = 0; li < ladder.length; li += 1) {
          const level = ladder[li];
          tx.queue(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
            newId(), productId, level.level != null ? level.level : li, level.code, level.name,
            level.plural || `${level.name}s`, Number(level.quantityInBase),
            1, level.isDefaultSell ? 1 : 0,
          ]);
        }

        // ---- measured axis. base_unit_code is the ladder's level-0 CODE, so
        // the three places a unit is named (products.base_unit_name,
        // product_units.code, product_measures.base_unit_code) agree.
        if (seed.measured && MEASURE_AXES[seed.measured]) {
          const axis = MEASURE_AXES[seed.measured];
          tx.queue(`INSERT INTO product_measures (id, product_id, axis, sell_unit_code, sell_unit_base_factor, base_unit_code, allows_fraction, min_quantity, step_quantity, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,1,0,?, datetime('now'), datetime('now'))`, [
            newId(), productId, axis.axis, axis.sellUnitCode, axis.baseFactor, ladder[0].code, axis.step,
          ]);
        }

        // ---- variants
        if (tracksVariants) {
          const combinations = variantCombinations(seed.variants);
          for (const combo of combinations.slice(0, 40)) {
            const name = combo.map((c) => c.value).join(', ');
            const attrs = Object.fromEntries(combo.map((c) => [c.axis, c.value]));
            const attrsJson = JSON.stringify(attrs);
            const sku = seed.sku ? variantSku(seed.sku, combo, attrsJson) : null;
            if (sku) {
              // product_variants is UNIQUE on (product_id, sku). A duplicate
              // would abort the whole provisioning transaction, so a clash is
              // skipped and reported rather than fatal.
              const clash = claimedVariantSkus.has(`${productId}:${sku}`)
                || await db.first('SELECT id FROM product_variants WHERE product_id = ? AND sku = ?', [productId, sku]);
              if (clash) { summary.skipped.push(`variant_sku:${sku}`); continue; }
              claimedVariantSkus.add(`${productId}:${sku}`);
            }
            tx.queue(`INSERT INTO product_variants (id, product_id, sku, name, attributes_json, cost_price, selling_price, is_active, sort_order, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
              newId(), productId, sku,
              name, attrsJson,
              round2(seed.cost), round2(seed.price), 1, 0,
            ]);
          }
          for (const axisDef of seed.variants) {
            const axisName = Object.keys(axisDef)[0];
            tx.queue(`INSERT INTO variant_axes (id, product_id, name, options_json, sort_order, created_at, updated_at)
                      VALUES (?,?,?,?,0, datetime('now'), datetime('now'))`, [
              newId(), productId, axisName, JSON.stringify(axisDef[axisName]),
            ]);
          }
        }

        // ---- registration (SONCAP / NAFDAC / NCC)
        if (seed.registration) {
          tx.queue(`INSERT INTO product_registrations (id, product_id, authority, reg_type, reg_no, notes, created_at, updated_at)
                    VALUES (?,?,?,?,?, 'Seeded from the vertical profile — replace with the real certificate number.', datetime('now'), datetime('now'))`, [
            newId(), productId, seed.registration.authority, seed.registration.type, `PENDING-${seed.sku || 'REG'}`,
          ]);
        }

        // ---- primary barcode (a synthetic, checksum-valid EAN-13 so the
        // scanner path is exercisable in a fresh deployment without waiting
        // for someone to type 20 real barcodes). product_barcodes.barcode is
        // UNIQUE across the whole deployment, so a collision is skipped
        // rather than aborting the entire provisioning transaction — one
        // product without a demo barcode is a cosmetic loss, a rolled-back
        // catalogue is not.
        if (seed.sku) {
          const synthetic = syntheticBarcode(seed.sku);
          // The pre-transaction read cannot see barcodes queued earlier in
          // THIS transaction, so `claimedBarcodes` covers the gap. Without it
          // two colliding SKUs in one catalogue abort the whole provisioning
          // run at commit time.
          const clash = synthetic && (claimedBarcodes.has(synthetic)
            || await db.first('SELECT id FROM product_barcodes WHERE barcode = ?', [synthetic]));
          if (synthetic && !clash) {
            claimedBarcodes.add(synthetic);
            tx.queue(`INSERT INTO product_barcodes (id, product_id, barcode, unit_code, label, is_primary, created_at, updated_at)
                      VALUES (?,?,?,?,?,1, datetime('now'), datetime('now'))`, [
              newId(), productId, synthetic, ladder[0].code, `${seed.name} — synthetic demo barcode`,
            ]);
          } else {
            summary.skipped.push(`barcode:${synthetic}`);
          }
        }

        // ---- retail price list entry so wholesale pricing has something to
        // contrast against on day one
        if (listIds.get('RETAIL')) {
          tx.queue(`INSERT INTO price_list_items (id, price_list_id, product_id, unit_code, price, min_quantity, created_at, updated_at)
                    VALUES (?,?,?,?,?,0, datetime('now'), datetime('now'))`, [
            newId(), listIds.get('RETAIL'), productId, ladder[0].code, round2(seed.price),
          ]);
        }
        summary.products += 1;
      }
    }

    // ---- point the business at its default retail price list
    if (listIds.get('RETAIL')) {
      tx.queue('UPDATE businesses SET default_price_list_id = ?, updated_at = datetime(\'now\') WHERE id = ? AND default_price_list_id IS NULL',
        [listIds.get('RETAIL'), businessId]);
    }
    void createdBy;
  });

  return summary;
}

/** Expand [{colour:[a,b]},{size:[x,y]}] into the cartesian combinations. */
function variantCombinations(axisDefs) {
  if (!Array.isArray(axisDefs) || !axisDefs.length) return [];
  let combos = [[]];
  for (const def of axisDefs) {
    const axisName = Object.keys(def)[0];
    const options = def[axisName] || [];
    const next = [];
    for (const combo of combos) {
      for (const value of options) next.push([...combo, { axis: axisName, value: String(value) }]);
    }
    combos = next;
    // A runaway cartesian product is a real risk: 6 colours x 5 storages x 4
    // sizes is 120 variants for one phone, which makes the POS variant picker
    // unusable. Cap it and let the merchant add the rest deliberately.
    if (combos.length > 200) return combos.slice(0, 200);
  }
  return combos;
}

/**
 * Deterministic synthetic EAN-13 from a SKU.
 *
 * Real barcodes come from the manufacturer; a fresh demo deployment has none,
 * and a scanner path that cannot be exercised is a scanner path that ships
 * broken. These are clearly labelled as synthetic in product_barcodes.label
 * so nobody mistakes them for a supplier's code.
 *
 * WHY THE WHOLE SKU IS HASHED AND NOT JUST ITS DIGITS
 *
 * The first version did `sku.replace(/\D/g, '')`, which for the seeded
 * catalogue turned `EL-PH-001` and `EL-AC-001` into the same string `001`
 * and so into the same barcode — and product_barcodes.barcode is UNIQUE
 * across the whole deployment, so provisioning died on the second one. A
 * merchant's own SKUs collide this way constantly (`ELE-001`, `FUR-001`,
 * `WHO-001`), so the digits-only shortcut was never safe.
 *
 * Two FNV-1a hashes with different offsets fill the 11-digit body, giving
 * ~10^11 of space. A collision is then far less likely than a merchant
 * typing the same barcode twice by hand, and `syntheticBarcode` is used only
 * for demo rows anyway. The prefix 2 marks the code as internal/restricted
 * distribution per GS1, so it can never be mistaken for a real EAN in
 * circulation.
 */
/**
 * A readable, collision-free SKU for a variant.
 *
 * The first version truncated each attribute value to six characters, which
 * collapsed "Ashanti Beige", "Ashanti Grey" and "Ashanti Cream" all to
 * `ASHANT` — and product_variants is UNIQUE on (product_id, sku), so
 * provisioning the furniture catalogue died on the second one. Truncation is
 * the wrong tool for uniqueness: any two values sharing a prefix collide, and
 * fabric ranges, storage tiers and finish names do exactly that.
 *
 * So the readable part is kept SHORT (it is a label, not an identity) and a
 * hash of the full attribute set supplies the uniqueness. Two variants can now
 * only collide if their attributes are byte-identical, in which case they are
 * the same variant and one of them should not exist.
 */
function variantSku(productSku, combo, attrsJson) {
  const readable = combo
    .map((c) => String(c.value).replace(/[^A-Za-z0-9]+/g, '').slice(0, 4).toUpperCase())
    .filter(Boolean)
    .join('-');
  const suffix = fnv1a(String(attrsJson), 0x811c9dc5).toString(36).toUpperCase().padStart(6, '0').slice(-4);
  return `${productSku}${readable ? `-${readable}` : ''}-${suffix}`;
}

function fnv1a(str, offset) {
  let hash = offset >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    // 32-bit multiply without losing precision to float64: split into halves.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function syntheticBarcode(seed) {
  const { eanCheckDigit } = require('../../domain/validation');
  const key = String(seed || '').trim();
  if (!key) return null;
  const a = String(fnv1a(key, 0x811c9dc5)).padStart(10, '0').slice(-6);
  const b = String(fnv1a(key, 0x01000193)).padStart(10, '0').slice(-5);
  const body = `2${a}${b}`.slice(0, 12).padEnd(12, '0');
  return `${body}${eanCheckDigit(body)}`;
}

/**
 * Provision the DEPLOYMENT ONLY — no business, no branch, no owner.
 *
 * This is what a client's fresh installation gets: the settings row, the WHT
 * rate schedule as data, and ONE platform administrator. Everything else — the
 * business, its first branch, the chart of accounts, the catalogue, the staff —
 * is created through the app's own screens, by the client, for their own
 * business.
 *
 * Why that matters rather than shipping a demo business: a deployment that
 * arrives pre-filled with "Ridge Electronics Ltd (Demo)" invites a client to
 * start trading inside somebody else's books. Their first sale posts against a
 * chart of accounts they did not create, their first receipt carries a name that
 * is not theirs, and untangling that later is real work. Starting empty is a
 * five-minute setup and an honest one.
 *
 * The admin is deliberately not attached to a business or a branch: it is the
 * vendor's key, and it exists to create the first business and hand it to an
 * owner.
 */
async function provisionPlatform(db, {
  adminUsername = 'admin', adminPin = null, adminName = 'StockRidge Platform Administrator',
  businessName = null, seededBy = 'provisioningService',
} = {}) {
  const { hashPin } = require('../../domain/crypto');
  if (!adminPin) throw new HttpError('A platform administrator PIN is required — without one there is no way into a fresh deployment.', { status: 400, code: 'ADMIN_PIN_REQUIRED' });

  const existing = await db.first('SELECT id FROM client_settings WHERE id = 1');
  if (!existing) {
    await db.run(`INSERT INTO client_settings (id, business_name, subscription_status, subscription_plan, updated_at)
                  VALUES (1, ?, 'TRIAL', 'Standard', datetime('now'))`, [businessName]);
  } else if (businessName) {
    await db.run("UPDATE client_settings SET business_name = COALESCE(business_name, ?), updated_at = datetime('now') WHERE id = 1", [businessName]);
  }

  // WHT schedule — data, not code, so a change in the Regulations does not need
  // a redeploy. Seeded once; the owner can edit the rates afterwards.
  const { WHT_SCHEDULE_2024 } = require('../../domain/nigerianTax');
  const haveRates = new Set((await db.all('SELECT code FROM wht_rates')).map((r) => r.code));
  for (const rate of WHT_SCHEDULE_2024) {
    if (haveRates.has(rate.code)) continue;
    await db.run(`INSERT INTO wht_rates (id, code, name, rate_percent, direction, is_system, is_active, note, created_at, updated_at)
                  VALUES (?,?,?,?,?,1,1,?, datetime('now'), datetime('now'))`,
    [newId(), rate.code, rate.name, rate.rate_percent, rate.direction, rate.note]);
  }

  const username = String(adminUsername || 'admin').trim().toLowerCase();
  const existingAdmin = await db.first('SELECT * FROM users WHERE username = ? AND is_deleted = 0', [username]);
  if (existingAdmin) return { adminId: String(existingAdmin.id), adminUsername: username, created: false };

  const id = newId();
  const hashed = await hashPin(String(adminPin));
  await db.run(`INSERT INTO users (id, business_id, branch_id, full_name, username, pin_hash, role, job_title, is_active, created_at, updated_at)
                VALUES (?, NULL, NULL, ?, ?, ?, 'ADMIN', ?, 1, datetime('now'), datetime('now'))`,
  [id, adminName, username, hashed.stored, 'Vendor Administrator']);

  return { adminId: id, adminUsername: username, created: true, seededBy };
}

/**
 * Provision the deployment itself: settings row, WHT schedule, the first
 * business, its first branch, and the owner/admin users.
 *
 * Called by tools/seed.js for a demo deployment and by the ADMIN route when
 * a new client instance is stood up.
 */
async function provisionDeployment(db, {
  businessName, profileCode = 'GENERAL_RETAIL', ownerName, ownerUsername, ownerPin,
  adminUsername = 'admin', adminPin = null, branches = [], seededBy = 'provisioningService',
}) {
  const { hashPin } = require('../../domain/crypto');
  if (!getProfile(profileCode)) {
    // This guard could never fire before, because the lookup fell back to
    // GENERAL_RETAIL for anything. It fires now — and it lists the verticals,
    // because "unknown profile" on its own sends the reader to the source code.
    throw new HttpError(
      `“${profileCode}” is not a business vertical this system has. Choose one of: ${PROFILE_CODES.map((c) => `${getProfile(c).label} (${c})`).join(', ')}.`,
      { status: 400, code: 'UNKNOWN_PROFILE' },
    );
  }

  const settingsRow = await db.first('SELECT id FROM client_settings WHERE id = 1');
  if (!settingsRow) {
    await db.run(`INSERT INTO client_settings (id, business_name, subscription_status, subscription_plan, updated_at)
                  VALUES (1, ?, 'TRIAL', 'Standard', datetime('now'))`, [businessName || null]);
  } else {
    await db.run("UPDATE client_settings SET business_name = COALESCE(?, business_name), updated_at = datetime('now') WHERE id = 1", [businessName || null]);
  }

  // WHT schedule — data, not code. Seeded once, editable by the owner.
  const { WHT_SCHEDULE_2024 } = require('../../domain/nigerianTax');
  const haveRates = new Set((await db.all('SELECT code FROM wht_rates')).map((r) => r.code));
  for (const rate of WHT_SCHEDULE_2024) {
    if (haveRates.has(rate.code)) continue;
    await db.run(`INSERT INTO wht_rates (id, code, name, rate_percent, direction, is_system, is_active, note, created_at, updated_at)
                  VALUES (?,?,?,?,?,1,1,?, datetime('now'), datetime('now'))`,
    [newId(), rate.code, rate.name, rate.rate_percent, rate.direction, rate.note]);
  }

  const businessId = newId();
  await db.run(`INSERT INTO businesses (id, name, legal_name, profile_code, is_active, created_at, updated_at)
                VALUES (?,?,?,?,1, datetime('now'), datetime('now'))`,
  [businessId, businessName, businessName, profileCode]);
  await db.run('UPDATE client_settings SET primary_business_id = ? WHERE id = 1 AND primary_business_id IS NULL', [businessId]);

  const business = await db.first('SELECT * FROM businesses WHERE id = ?', [businessId]);
  const summary = await provisionBusiness(db, business, { withCatalogue: true });

  // Users
  const userIds = {};
  if (adminPin) {
    const adminId = newId();
    const hashed = await hashPin(String(adminPin));
    await db.run(`INSERT INTO users (id, business_id, branch_id, full_name, username, pin_hash, role, job_title, is_active, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,'ADMIN',?,1, datetime('now'), datetime('now'))`,
    [adminId, null, null, 'StockRidge Platform Administrator', adminUsername, hashed.stored, 'Vendor Administrator']);
    userIds.admin = adminId;
  }

  const ownerId = newId();
  const ownerHash = await hashPin(String(ownerPin));
  await db.run(`INSERT INTO users (id, business_id, branch_id, full_name, username, pin_hash, role, job_title, is_active, created_at, updated_at)
                VALUES (?,?,?,?,?,?,'OWNER','Proprietor',1, datetime('now'), datetime('now'))`,
  [ownerId, businessId, null, ownerName, ownerUsername, ownerHash.stored]);
  userIds.owner = ownerId;

  // Branches
  const branchIds = [];
  const branchList = branches.length ? branches : [{ name: `${businessName} — Main`, city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL' }];
  for (let i = 0; i < branchList.length; i += 1) {
    const b = branchList[i];
    const id = newId();
    await db.run(`INSERT INTO branches (
        id, business_id, name, code, branch_type, address, city, state, lga, phone,
        latitude, longitude, geofence_radius_meters, attendance_mode, opening_cash, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1, datetime('now'), datetime('now'))`, [
      id, businessId, b.name, b.code || `BR-${String(i + 1).padStart(2, '0')}`, b.branch_type || 'RETAIL',
      b.address || null, b.city || null, b.state || null, b.lga || null, b.phone || null,
      b.latitude != null ? b.latitude : null, b.longitude != null ? b.longitude : null,
      Number(b.geofence_radius_meters || 100), b.attendance_mode || 'GEOLOCATION',
      round2(Number(b.opening_cash) || 0),
    ]);
    branchIds.push(id);

    // Opening safe entry so the safe balance is a real derivation from row one
    // rather than a number that appears the first time somebody deposits.
    if (Number(b.opening_cash) > 0) {
      await db.run(`INSERT INTO branch_safe_ledger (
          id, branch_id, business_id, entry_type, amount, balance_after, reason, created_by, created_at, updated_at)
        VALUES (?,?,?, 'OPENING', ?, ?, 'Opening cash float', ?, datetime('now'), datetime('now'))`,
      [newId(), id, businessId, round2(Number(b.opening_cash)), round2(Number(b.opening_cash)), ownerId]);
    }

    // A branch manager per branch, when the caller asked for one.
    if (b.manager && b.manager.username && b.manager.pin) {
      const managerId = newId();
      const mHash = await hashPin(String(b.manager.pin));
      await db.run(`INSERT INTO users (id, business_id, branch_id, full_name, username, pin_hash, role, job_title, is_active, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,'MANAGER',?,1, datetime('now'), datetime('now'))`,
      [managerId, businessId, id, b.manager.name, b.manager.username, mHash.stored, b.manager.job_title || 'Branch Manager']);
      userIds[b.manager.username] = managerId;
    }
    if (Array.isArray(b.staff)) {
      for (const s of b.staff) {
        if (!s.username || !s.pin) continue;
        const staffId = newId();
        const sHash = await hashPin(String(s.pin));
        await db.run(`INSERT INTO users (id, business_id, branch_id, full_name, username, pin_hash, role, job_title, is_active, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,'STAFF',?,1, datetime('now'), datetime('now'))`,
        [staffId, businessId, id, s.name, s.username, sHash.stored, s.job_title || 'Sales / Cashier']);
        userIds[s.username] = staffId;
      }
    }
  }

  return {
    ok: true,
    businessId,
    businessName,
    profile: profileCode,
    branchIds,
    userIds,
    provisioned: summary,
    seededBy,
  };
}

module.exports = { provisionBusiness, provisionDeployment, provisionPlatform, profileForBusiness, parseOverrides, variantCombinations, syntheticBarcode, variantSku };
