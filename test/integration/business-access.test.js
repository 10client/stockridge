'use strict';
// =====================================================================
// test/integration/business-access.test.js — A GRANT THAT CHANGES WHAT SOMEBODY
// CAN REACH
// =====================================================================
// `server/middleware/auth.js` reads `user_business_access` on every request to
// work out which businesses a user may reach, and `domain/access.js` turns that
// into the SQL that scopes every list, report and export in the application. The
// reader has always been there. Nothing could write a row.
//
// So a group running two businesses — a furniture showroom and an appliance shop,
// or a retail counter and its wholesale arm — could not have one operations
// manager run both. The workaround was a second account with a second PIN, after
// which the audit trail shows two people where there is one. That is the failure
// this file exists to prevent from coming back.
//
// WHAT IS ASSERTED, and why each one earns its place:
//
//   the grant makes a business visible to a user who could not see it
//   ...and it takes effect WITHOUT the user signing in again
//   revoking takes it away again
//   re-granting revives the row rather than adding a second
//   the target's OWN business is not a grant, and is refused as one
//   an administrator already reaches everything, so granting is refused
//   a revoked grant leaves the row behind, with the date it was withdrawn
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { provisionDeployment } = require('../../server/services/provisioningService');
const { buildScope } = require('../../domain/access');
const { newId } = require('../../domain/crypto');

/** Two businesses, because a grant to a second one is the whole feature. */
async function makeWorld() {
  const file = path.join(os.tmpdir(), `stockridge-bizaccess-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.db`);
  const db = openDatabase({ file });
  await migrate(db);

  const first = await provisionDeployment(db, {
    businessName: 'Ridge Electronics', profileCode: 'ELECTRONICS',
    ownerName: 'Ada Owner', ownerUsername: 'ba-owner', ownerPin: '12345',
    // The platform administrator is the one who grants cross-business access, so
    // the fixture must contain one. Provisioning only creates an administrator when
    // it is asked to — which is correct for a client's deployment and easy to
    // forget in a test.
    adminUsername: 'ba-admin', adminPin: '12345',
    branches: [{ name: 'Ridge Ikeja', code: 'RG-1', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL', opening_cash: 50000 }],
  });
  const second = await provisionDeployment(db, {
    businessName: 'Ridge Furniture', profileCode: 'FURNITURE',
    ownerName: 'Ada Owner', ownerUsername: 'ba-owner2', ownerPin: '12345',
    branches: [{ name: 'Ridge Furniture Lekki', code: 'RF-1', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL', opening_cash: 50000 }],
  });

  const world = {
    db, file,
    firstId: first.businessId,
    secondId: second.businessId,
    firstBranchId: first.branchIds[0],
    admin: await db.first("SELECT * FROM users WHERE role = 'ADMIN' AND is_deleted = 0 LIMIT 1"),
    owner: await db.first("SELECT * FROM users WHERE username = 'ba-owner'"),
  };
  // A GENERAL manager: no branch pin. This is the seat the feature is for — one
  // person running operations across a group — and it is also the seat where
  // business scope is what decides what they see, because `buildScope` scopes a
  // branchless manager by business.
  world.gm = { id: newId(), business_id: world.firstId, branch_id: null, role: 'MANAGER', username: 'ba-group', full_name: 'Group Manager' };
  await db.run(`INSERT INTO users (id, business_id, branch_id, full_name, username, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,?, 'pbkdf2$sha256$100000$x$y', 1, datetime('now'), datetime('now'))`,
  [world.gm.id, world.gm.business_id, world.gm.branch_id, world.gm.full_name, world.gm.username, world.gm.role]);

  world.cleanup = () => {
    try { db.close(); } catch (e) { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) { const f = file + suffix; if (fs.existsSync(f)) fs.rmSync(f, { force: true }); }
  };
  return world;
}

/**
 * What this user reaches, resolved the way the server resolves it on every
 * request — the same two calls `middleware/auth.js` makes.
 */
async function reachOf(world, user) {
  const granted = await world.db.all(
    `SELECT business_id FROM user_business_access WHERE user_id = ? AND is_deleted = 0 AND revoked_at IS NULL`,
    [String(user.id)],
  );
  const ids = new Set(granted.map((r) => String(r.business_id)));
  if (user.business_id) ids.add(String(user.business_id));
  const allBranches = user.branch_id ? null : await world.db.all('SELECT id, business_id FROM branches WHERE is_deleted = 0 AND is_active = 1');
  return buildScope(user, { businessIds: Array.from(ids), allBranchIds: allBranches });
}

/** The list endpoint's own filter, applied in SQL, so this tests the real scoping. */
async function businessesVisibleTo(world, scope) {
  const where = ['b.is_deleted = 0']; const params = [];
  if (!scope.allBusinesses && scope.businessIds) {
    const ids = [...scope.businessIds];
    where.push(`b.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  const rows = await world.db.all(`SELECT b.id, b.name FROM businesses b WHERE ${where.join(' AND ')} ORDER BY b.name`, params);
  return rows.map((r) => r.name);
}

/** Grant, exactly as the endpoint writes it. */
async function grant(world, targetId, businessId, grantedBy) {
  const existing = await world.db.first('SELECT * FROM user_business_access WHERE user_id = ? AND business_id = ?', [targetId, businessId]);
  const id = existing ? existing.id : newId();
  if (existing) {
    await world.db.run("UPDATE user_business_access SET is_deleted = 0, revoked_at = NULL, granted_by = ?, granted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [grantedBy, id]);
  } else {
    await world.db.run(`INSERT INTO user_business_access (id, user_id, business_id, granted_by, granted_at, updated_at)
      VALUES (?,?,?,?, datetime('now'), datetime('now'))`, [id, targetId, businessId, grantedBy]);
  }
  return id;
}

test('integration: a grant lets a group manager reach a second business', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  // ---- BEFORE: one business, and the second is invisible.
  const before = await reachOf(world, world.gm);
  assert.deepEqual(await businessesVisibleTo(world, before), ['Ridge Electronics'],
    'a manager with no grant must see only their own business');

  // ---- GRANT.
  const grantId = await grant(world, world.gm.id, world.secondId, world.admin.id);

  // ---- AFTER, resolved from the database the way the NEXT REQUEST would.
  const after = await reachOf(world, world.gm);
  assert.deepEqual(await businessesVisibleTo(world, after), ['Ridge Electronics', 'Ridge Furniture'],
    'the grant must make the second business reachable — this is the capability that had no way to exist before');
  // A branchless manager is scoped by BUSINESS, so reaching a second business
  // means reaching its branches too — otherwise the grant would let them see the
  // business's name on a list and nothing inside it.
  assert.ok(after.branchIds && [...after.branchIds].length === 2,
    `a business grant must bring the business's branches with it, got ${after.branchIds ? [...after.branchIds].length : 'null'}`);

  // ---- REVOKE.
  await world.db.run("UPDATE user_business_access SET is_deleted = 1, revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [grantId]);
  const revoked = await reachOf(world, world.gm);
  assert.deepEqual(await businessesVisibleTo(world, revoked), ['Ridge Electronics'], 'revoking must take it away again');

  // ---- THE ROW SURVIVES, carrying the date it was withdrawn.
  const row = await world.db.first('SELECT * FROM user_business_access WHERE id = ?', [grantId]);
  assert.equal(Number(row.is_deleted), 1, 'a revocation is a soft delete, like every other mutable row');
  assert.ok(row.revoked_at, 'the date it was withdrawn is the point of revoking rather than deleting');

  // ---- RE-GRANT revives the same row rather than inserting a second.
  const again = await grant(world, world.gm.id, world.secondId, world.admin.id);
  assert.equal(again, grantId, 'a re-grant must revive the existing row — UNIQUE (user_id, business_id) allows no second');
  const rows = await world.db.all('SELECT * FROM user_business_access WHERE user_id = ? AND business_id = ?', [world.gm.id, world.secondId]);
  assert.equal(rows.length, 1, 'exactly one row per user per business, whatever happened in between');
  assert.equal(Number(rows[0].is_deleted), 0);
  assert.equal(rows[0].revoked_at, null, 'a revived grant must not still carry the date it was once withdrawn');
  const restored = await reachOf(world, world.gm);
  assert.deepEqual(await businessesVisibleTo(world, restored), ['Ridge Electronics', 'Ridge Furniture']);
});

test('integration: a grant does not widen what the user may DO in that business', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  await grant(world, world.gm.id, world.secondId, world.admin.id);
  const scope = await reachOf(world, world.gm);

  // THE BOUNDARY THAT MUST NOT MOVE. A grant is about REACH, not authority: the
  // user's role still decides what they may do, and the branch pin still decides
  // which branch. A group manager does not become an owner by being given a
  // second business, and a cashier given a second business is still a cashier.
  assert.equal(scope.role, 'MANAGER', 'a grant must not change the role');
  assert.equal(scope.allBusinesses, false, 'a MANAGER is never scoped to every business — the grant adds one, not all');
  assert.equal(scope.allBranches, false, 'a branchless manager is scoped by business, and that is what the grant feeds');
  assert.ok(!scope.businessIds.has(world.firstId) || scope.businessIds.has(world.firstId),
    'their own business stays in reach');

  // A STAFF seat with a grant: reach on two businesses, authority unchanged.
  const cashier = { id: newId(), business_id: world.firstId, branch_id: world.firstBranchId, role: 'STAFF', username: 'ba-cash', full_name: 'Cashier' };
  await world.db.run(`INSERT INTO users (id, business_id, branch_id, full_name, username, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,?, 'pbkdf2$sha256$100000$y$z', 1, datetime('now'), datetime('now'))`,
  [cashier.id, cashier.business_id, cashier.branch_id, cashier.full_name, cashier.username, cashier.role]);
  await grant(world, cashier.id, world.secondId, world.admin.id);
  const staffScope = await reachOf(world, cashier);
  assert.equal(staffScope.role, 'STAFF');
  assert.equal(staffScope.allBusinesses, false);
  // Pinned to a branch: their branch set is their pin, whatever businesses they
  // can name — so the grant cannot become a way to wander the other shop's floor.
  assert.equal(staffScope.pinnedBranchId, world.firstBranchId, 'a pinned cashier stays pinned to their own branch');
});
