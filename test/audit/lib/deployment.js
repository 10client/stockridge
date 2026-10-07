'use strict';
// =====================================================================
// test/audit/lib/deployment.js — A LIVE DEPLOYMENT FOR EACH AUDIT
// =====================================================================
// PharmaRidge's audits run against a real server, and its runner gives each
// script a FRESH database — "isolation prevents one role's exercise from becoming
// another role's fixture or false failure". This is that, for StockRidge:
//
//   1. a new database file, migrated
//   2. a provisioned deployment (business, branches, owner, staff, catalogue)
//   3. `server/app.js` as a CHILD PROCESS, on its own port, waited for
//   4. actors signed in over HTTP, remembering their tokens
//
// WHY A CHILD PROCESS AND NOT `app.fetch()`.
//
// `test/helpers/deployment.js` calls the app in-process, which is fast and right
// for unit-shaped integration tests. An audit is a different instrument: it is
// asking whether the thing that will be deployed works, and the parts it cannot
// see in-process are exactly the ones that have broken this project — the static
// file server, the 404 handler, the request logger, the way a route is mounted,
// the way a body is parsed. So the audit talks to a socket.
//
// The port is chosen per audit and passed in, because a stale server on a fixed
// port makes a passing audit a lie.
// =====================================================================

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** A port nobody is listening on, by asking the OS for one and letting it go. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Signed-in seats, with their tokens remembered. */
class Actor {
  constructor(deployment, { username, pin, role, token, user }) {
    this.deployment = deployment;
    this.username = username;
    this.pin = pin;
    this.role = role || (user && user.role) || null;
    this.token = token;
    this.user = user || null;
  }

  headers(extra = {}) {
    return Object.assign({ Authorization: `Bearer ${this.token}` }, extra);
  }

  async call(method, urlPath, body, opts = {}) {
    return this.deployment.request(method, urlPath, Object.assign({ token: this.token, body }, opts));
  }

  get(urlPath, opts) { return this.call('GET', urlPath, undefined, opts); }
  post(urlPath, body, opts) { return this.call('POST', urlPath, body, opts); }
  put(urlPath, body, opts) { return this.call('PUT', urlPath, body, opts); }
  del(urlPath, opts) { return this.call('DELETE', urlPath, undefined, opts); }

  /** Change this actor's seat — used by the role-lifecycle audit, where what
   *  matters is what an EXISTING session can do after the role behind it moves. */
  async as(username, pin) {
    return this.deployment.login({ username, pin });
  }
}

class Deployment {
  constructor({ base, port, dbFile, child, admin, log, live = false, settings = null }) {
    this.base = base;
    this.port = port;
    this.dbFile = dbFile;
    this.child = child;
    this.admin = admin;
    this.actors = new Map();
    this.log = log || '';
    this._requests = 0;
    /**
     * IS THIS SOMEBODY ELSE'S DEPLOYMENT?
     *
     * When an audit is pointed at a live worker (`AUDIT_BASE=…`), it does not own
     * the database: it cannot migrate, cannot seed, and must not delete anything it
     * did not create. Audits read `d.live` when the difference matters — chiefly to
     * provision their fixture through the API rather than the service, and to clean
     * up only what they made.
     */
    this.live = live;
    this.settings = settings;
    this.writable = false;
    this.branches = [];
    this.seats = {};
    /** Everything this run created, so a live run can undo exactly its own work. */
    this.created = { users: [], businesses: [] };
  }

  /** One HTTP call, with the headers a real client sends. */
  async request(method, urlPath, { token, body, headers = {}, idempotencyKey, device = 'audit-device' } = {}) {
    this._requests += 1;
    const h = Object.assign({ 'X-Device-Id': device }, headers);
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey;
    const res = await fetch(this.base + urlPath, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // THE RAW BYTES ARE KEPT AS WELL AS THE TEXT. Reading a body as text runs it through
    // the WHATWG decoder, which STRIPS a leading byte-order mark by design — so a test that
    // checks a CSV's BOM by looking at `text` is testing the decoder, not the export. The
    // bytes are what a spreadsheet receives and what a BOM check has to look at.
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = { _raw: text.slice(0, 400) }; }
    return { status: res.status, json, text, bytes: buffer, headers: Object.fromEntries(res.headers.entries()), url: urlPath, method };
  }

  /** Sign in and keep the seat. Throws on failure — see the harness note about
   *  a probe that skips. */
  async login({ username, pin, remember = true }) {
    // THE FIXTURE SIGNS IN THE WAY THE APP DOES. The app sends a stable per-device id on
    // every request (`X-Device-Id`), and the sign-in route records it against the session, so
    // a fixture that omits it leaves `device_id` null everywhere and quietly proves nothing
    // about the column that a manager relies on to cut off the right phone.
    const res = await this.request('POST', '/api/auth/login', {
      body: { username, pin, deviceId: `audit-${username}` },
    });
    if (res.status !== 200 || !res.json || !res.json.token) {
      throw new Error(`could not sign in as ${username}: ${res.status} ${res.text.slice(0, 200)}`);
    }
    const actor = new Actor(this, { username, pin, user: res.json.user, token: res.json.token });
    if (remember) this.actors.set(username, actor);
    return actor;
  }

  /** Sign in through the API as the ONE administrator, if the fixture made one. */
  async asAdmin() {
    if (this.admin) return this.admin;
    const res = await this.request('GET', '/api/health');
    void res;
    throw new Error('this deployment was built without an administrator');
  }

  /**
   * WHICH BRANCH AN AUDIT SHOULD TRADE IN, given who it is trading as.
   *
   * An audit that just takes `branches[0]` is correct on a fresh single-business database
   * and wrong everywhere else. On a real deployment `GET /api/branches` returns everything
   * the caller can reach — an OWNER reaches every branch of every business — and the order
   * is whatever the query returns. Trading in a branch that belongs to a different business
   * from the audit's own product and customer produced
   * `403 CROSS_BUSINESS_CUSTOMER`, which is the product being right about a fiction the
   * audit invented.
   *
   * The rule: the branch the actor is PINNED to if they have one (that is where they work),
   * otherwise the first branch of the business they belong to, otherwise the first branch
   * on the deployment.
   */
  branchFor(actor) {
    const list = this.branches || [];
    if (!list.length) return null;
    if (actor && actor.branchId) {
      const pinned = list.find((b) => String(b.id) === String(actor.branchId));
      if (pinned) return pinned;
    }
    if (this.primaryBranchId) {
      const primary = list.find((b) => String(b.id) === String(this.primaryBranchId));
      if (primary && (!actor || !actor.businessId || String(primary.business_id) === String(actor.businessId))) return primary;
    }
    if (actor && actor.businessId) {
      const own = list.find((b) => String(b.business_id) === String(actor.businessId));
      if (own) return own;
    }
    return list[0];
  }

  /**
   * GIVE THIS AUDIT SOMEBODY TO SIGN IN AS.
   *
   * Everything interesting in this system is a question about WHO is asking, so an
   * audit that only ever holds an administrator's token is an audit of half the
   * product. `seat()` creates a real user through the real endpoint — a manager
   * pinned to one branch, a cashier, a storekeeper — and returns an actor holding
   * that seat's token. The user is created by the owner where there is one, which
   * is exactly how a client makes a user.
   *
   * It goes through POST /api/users rather than straight to the database on
   * purpose: a fixture written behind the API's back can hold a PIN hash the
   * sign-in path would not accept, and then the audit fails for a reason that
   * exists only inside the audit.
   */
  async seat({ full_name, username, pin = '73041', role = 'MANAGER', branchId = null, businessId = null, via = null }) {
    // THE PIN IS 73041, NOT 12345, AND THAT IS A FINDING.
    //
    // A user created through POST /api/users cannot have a PIN of 1234 or 12345:
    // the strength rule refuses a straight run, and it is right to. The deployed
    // administrator on the live environments holds 1234 because the deployment tool
    // writes that PIN straight into the database when it provisions — which is a
    // deliberate bypass for a client's first sign-in, and it is worth knowing that
    // the same PIN could not be set again from inside the app.
    //
    // Fixtures therefore use a PIN the product will actually accept, because a
    // fixture that has to bypass validation fails for reasons that live only inside
    // the fixture.
    // THE ADMINISTRATOR PROVISIONS, and on a live deployment that is not a
    // preference — it is the only seat that works. An OWNER on a real deployment may
    // itself be branch-pinned (staging's is), and a pinned seat cannot name another
    // branch: creating the manager seat failed with a 403 BRANCH_SCOPE_VIOLATION that
    // was entirely correct and entirely useless to the audit. The deployment
    // administrator carries no branch, reaches every business, and is the seat that
    // provisions staff in the first place.
    const maker = via || this.admin || this.owner;
    if (!maker) throw new Error('no seat to create users from — the deployment has neither an administrator nor an owner signed in');
    const body = { full_name, username, pin, confirm_pin: pin, role };
    if (branchId) body.branch_id = branchId;
    if (businessId) body.business_id = businessId;
    const res = await maker.post('/api/users', body);
    if (res.status !== 201) throw new Error(`could not create the ${role} seat "${username}": ${res.status} ${res.text.slice(0, 240)}`);
    const actor = await this.login({ username, pin });
    actor.userId = (res.json && (res.json.id || res.json.userId)) || null;
    actor.role = role;
    if (actor.userId) this.created.users.push(actor);
    return this.describe(actor);
  }

  /**
   * MAKE AN ACTOR SAY WHO IT IS.
   *
   * Every assertion in an audit of this system is really "who is asking, and what
   * can they reach" — so an actor that can do nothing but carry a token leaves each
   * audit to guess at the answers, and guessing is how an audit ends up asserting
   * against `undefined`:
   *
   *   the branch the manager is pinned to is missing from the branches they can read
   *
   * That failure said nothing about the product. It happened because `actor.branchId`
   * was never set, so the comparison was `String(undefined)`, and it took a debug run
   * against a live server to see it. The fix belongs here, once, rather than as a
   * local variable in every audit.
   *
   * `/api/auth/me` is the authority on this and it is read with the ACTOR'S OWN
   * token, never a description the fixture wrote down: a fixture that records what
   * it intended proves only that it can keep a promise to itself.
   *
   * NOTE THE SHAPE, because it has already tripped an audit once: `me.user` carries
   * `branch` and `business` as OBJECTS (or null), not `branch_id`/`business_id`, and
   * the pinned ids live in `me.scope`. Reading `me.user.branch_id` yields undefined
   * and every comparison against it is meaningless.
   */
  async describe(actor) {
    const res = await actor.get('/api/auth/me');
    if (res.status !== 200) throw new Error(`could not read /api/auth/me as ${actor.username}: ${res.status} ${res.text.slice(0, 200)}`);
    const me = res.json || {};
    const user = me.user || {};
    actor.userId = user.id || actor.userId || null;
    actor.role = user.role || null;
    actor.roleLabel = user.roleLabel || null;
    actor.branchId = (user.branch && user.branch.id) || null;
    actor.businessId = (user.business && user.business.id) || null;
    actor.scope = me.scope || null;
    actor.pinnedBranchId = (me.scope && me.scope.pinnedBranchId) || null;
    actor.navigation = user.navigation || [];
    actor.branchCount = (me.branches || []).length;
    return actor;
  }

  /**
   * REMEMBER A USER THIS RUN CREATED BY ANOTHER ROUTE.
   *
   * `seat()` tracks its own, but an audit that probes a boundary by creating a user
   * as somebody ELSE — "can a manager create staff, and where does that row land?" —
   * creates one through a path `seat()` never sees. On a local run that is harmless;
   * on a live deployment it is an active account left behind in a client's tenant,
   * with a username that can never be reused. Every creation goes through here.
   */
  trackUser(userId) {
    if (userId) this.created.users.push({ userId });
    return userId || null;
  }

  /** A customer, a supplier, a product — anything an audit creates that a live
   *  deployment would otherwise keep. Recorded so `close()` can retire it. */
  trackCustomer(id) {
    if (!id) return null;
    this.created.customers = this.created.customers || [];
    this.created.customers.push({ id });
    return id || null;
  }

  trackSupplier(id) {
    if (!id) return null;
    this.created.suppliers = this.created.suppliers || [];
    this.created.suppliers.push({ id });
    return id || null;
  }

  /**
   * Something the audit CHANGED rather than created — a branch's geofence, a setting, a
   * device's status — together with how to put it back.
   *
   * On a local run nothing needs undoing: the database is thrown away. On a LIVE deployment
   * `branches[0]` is whatever the deployment happens to hold, and on staging that is another
   * audit's fixture branch, not the one this run owns. `audit.staff` set a 200m fence and
   * REGISTERED_DEVICE mode on `Roles Second Branch yfo3` and walked away, because the fixture
   * only creates its own business LOCALLY (see the live branch above) and the branch it used
   * was not its own. A write-mode audit that leaves a client's branch with somebody else's
   * attendance settings is worse than no audit at all — the shop would start flagging every
   * shift at the door. So: anything an audit changes, it registers here, and `close()` runs
   * the restores in reverse order, reporting how many succeeded.
   */
  trackRestore(label, undo) {
    if (typeof undo !== 'function') return null;
    this.created.restores = this.created.restores || [];
    this.created.restores.push({ label, undo });
    return null;
  }

  /** A user this run created, removed the way the app removes one. There is no
   *  DELETE /api/users — people are deactivated, never deleted, because their
   *  name is attached to sales they took years ago. */
  async retireUser(actor) {
    const id = actor && actor.userId;
    if (!id) return null;
    const maker = this.owner || this.admin;
    if (!maker) return null;
    return maker.put(`/api/users/${encodeURIComponent(id)}`, { is_active: false });
  }

  /**
   * PROVISION WHAT THIS AUDIT NEEDS, WHEREVER IT IS RUNNING.
   *
   * A local run provisions through the service, which is deterministic and fast. A
   * run against a live deployment has no such route — and going behind a live
   * server to write rows into its database would make the audit a liar about what
   * it proved. So `live` runs create the business through the API, exactly as a
   * client does, and the audit therefore also exercises the provisioning path.
   */
  async provision({ name, profileCode = 'ELECTRONICS', vatRegistered = false, branches = [] } = {}) {
    if (!this.live) throw new Error('provision() is for a live deployment; a local one is provisioned by startDeployment');
    if (!this.admin) throw new Error('provisioning through the API needs the administrator seat (AUDIT_ADMIN_PIN)');
    const created = [];
    for (const branch of branches) {
      const res = await this.admin.post('/api/businesses', {
        name, profile_code: profileCode, vat_registered: vatRegistered,
        branch: { name: branch.name, code: branch.code || undefined, city: branch.city, state: branch.state, branch_type: branch.branch_type || 'RETAIL', opening_cash: branch.opening_cash || 0 },
      });
      if (res.status !== 201) throw new Error(`could not create ${name}: ${res.status} ${res.text.slice(0, 200)}`);
      created.push({ businessId: res.json.id, branchId: res.json.branch_id, name, branch: branch.name });
      this.created.businesses.push(res.json.id);
      break; // the endpoint creates one business with its first branch
    }
    return created;
  }

  /**
   * UNDO WHAT THIS RUN MADE. A live deployment belongs to somebody.
   *
   * There is no DELETE /api/businesses either — a business is deactivated, because
   * its ledger is evidence. So "retire" means deactivate, and the audit says so
   * rather than pretending it cleaned up.
   */
  async retireBusiness(businessId) {
    const maker = this.admin || this.owner;
    if (!maker) return null;
    return maker.put(`/api/businesses/${encodeURIComponent(businessId)}`, { is_active: false });
  }

  async close() {
    if (this.live) {
      // NOT OURS TO SHUT DOWN — but ours to undo.
      //
      // A live run that creates a business and a handful of users must leave the
      // deployment as it found it, or the second run of the suite behaves differently
      // from the first and a client's environment slowly fills with audit debris. Both
      // are DEACTIVATED rather than deleted, because that is what the product does with
      // a user or a business — their past sales are still attributed to them — and
      // pretending otherwise in an audit would be its own small lie.
      if (!this.writable) return;
      const undone = { users: 0, businesses: 0, customers: 0, suppliers: 0 };

      // EVERYTHING THE AUDIT CHANGED IS PUT BACK FIRST, newest first, WHILE ITS OWN SEATS ARE
      // STILL ACTIVE. The restores authenticate as the audit's actors — a licence is removed
      // by the manager who filed it — and running them after the users were retired meant the
      // calls went out on a deactivated account and came back refused: the one restore that
      // mattered silently failed. Fixtures are retired after; settings are restored before.
      // See trackRestore above for why this matters more on a shared deployment than the
      // fixtures do.
      let restored = 0; const failedRestores = [];
      for (const r of (this.created.restores || []).slice().reverse()) {
        try { const ok = await r.undo(); if (ok) restored += 1; else failedRestores.push(r.label); }
        catch (e) { failedRestores.push(`${r.label} (${e.message})`); }
      }
      for (const actor of this.created.users) {
        try { const r = await this.retireUser(actor); if (r && r.status < 300) undone.users += 1; } catch (e) { /* reported below */ }
      }
      for (const businessId of this.created.businesses) {
        try { const r = await this.retireBusiness(businessId); if (r && r.status < 300) undone.businesses += 1; } catch (e) { /* reported below */ }
      }
      // A CUSTOMER IS SOFT-DELETED, WHICH IS THE ONE THING AN AUDIT MAY DO.
      // `DELETE /api/customers/:id` is a soft delete — the row stays, the ledger stays,
      // and the audit's test sale still reconciles. Leaving the fixture customer active
      // instead would put a person called "Audit Customer" on a client's debtors list
      // forever, which is worse than an invisible soft delete.
      for (const c of this.created.customers || []) {
        try { const r = await this.admin.del(`/api/customers/${encodeURIComponent(c.id)}`); if (r && r.status < 300) undone.customers += 1; } catch (e) { /* reported in the count */ }
      }
      for (const s of this.created.suppliers || []) {
        try { const r = await this.admin.put(`/api/suppliers/${encodeURIComponent(s.id)}`, { is_active: false }); if (r && r.status < 300) undone.suppliers += 1; } catch (e) { /* counted below */ }
      }
      console.log(`  left the live deployment as it was found: ${undone.users} user(s), ${undone.businesses} business(es), ${undone.customers} customer(s) and ${undone.suppliers} supplier(s) retired, ${restored} setting(s) put back${failedRestores.length ? ` — COULD NOT RESTORE: ${failedRestores.join(', ')}` : ''} (history is never deleted — this product does not do that)`);
      return;
    }
    if (!this.child || this.child.killed) return;
    await new Promise((resolve) => {
      this.child.once('exit', resolve);
      this.child.kill('SIGTERM');
      setTimeout(() => { try { this.child.kill('SIGKILL'); } catch (e) { /* gone */ } resolve(); }, 1500).unref();
    });
    // The database was a throwaway. Removing it keeps `.data` from filling with
    // one file per audit run, which is how a workspace grows to a gigabyte.
    if (this.dbFile && this.dbFile.includes('stockridge-audit-')) {
      for (const suffix of ['', '-wal', '-shm', '.jwt']) {
        try { fs.rmSync(this.dbFile + suffix, { force: true }); } catch (e) { /* fine */ }
      }
    }
  }
}

/**
 * A fresh deployment, provisioned, migrated, served on its own port.
 *
 * `provision` is the fixture, described as data: the audits differ in what they
 * need on the shelf, and nothing else. It is applied with the REAL provisioning
 * service, so the fixture cannot differ from what a client gets.
 */
async function startDeployment({
  label = 'audit',
  withAdmin = true,
  owner = { name: 'Audit Owner', username: 'audit-owner', pin: '12345' },
  admin = { username: 'audit-admin', pin: '12345' },
  businesses = [],
  seats = [],
  port: wantedPort = null,
  waitMs = 30000,
} = {}) {
  // ---- A LIVE TARGET, IF ONE WAS NAMED.
  //
  // `AUDIT_BASE=https://stockridge-staging.stockridge.workers.dev AUDIT_USER=admin
  //  AUDIT_PIN=1234 node test/audit/audit.http.js`
  //
  // The same audit file, the same assertions, against the deployment a client will
  // actually use. This is the single most valuable thing about this harness: a
  // green local run proves the code is right about the world it was written for,
  // and a green live run proves it about the world it will meet.
  const liveBase = process.env.AUDIT_BASE;
  if (liveBase) {
    const base = liveBase.replace(/\/$/, '');
    const deployment = new Deployment({ base, port: null, dbFile: null, child: null, admin: null, live: true });
    Object.defineProperty(deployment, 'serverLog', { get: () => '(a live deployment — see its own logs)' });
    const health = await fetch(`${base}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`AUDIT_BASE=${base} is not answering /api/health`);
    const username = process.env.AUDIT_USER || 'admin';
    const pin = process.env.AUDIT_PIN || '1234';
    deployment.admin = await deployment.login({ username, pin });
    if (process.env.AUDIT_OWNER_USER) {
      deployment.owner = await deployment.login({ username: process.env.AUDIT_OWNER_USER, pin: process.env.AUDIT_OWNER_PIN || pin });
    }
    // WHO THESE ACTORS ARE, BEFORE ANYTHING USES THEM. Without this the owner carries no
    // `businessId`, and the branch chooser below silently fell back to `branches[0]` — the
    // exact behaviour it exists to replace. A describe() that never ran is invisible: no
    // error, just a fixture quietly trading in somebody else's business.
    for (const actor of [deployment.owner, deployment.admin].filter(Boolean)) {
      await deployment.describe(actor);
    }

    const settings = await deployment.admin.get('/api/settings').catch(() => null);
    deployment.settings = settings && settings.json ? settings.json.settings : null;

    // A LIVE DEPLOYMENT IS READ-ONLY UNLESS SOMEBODY SAYS OTHERWISE.
    //
    // Somebody else's stockridge may be holding a client's real stock and real
    // money. The default posture is therefore: look, assert, touch nothing. Setting
    // AUDIT_WRITE=1 accepts that this run will create a business and a handful of
    // users, and that it will deactivate only what it created. That is a decision a
    // person makes about a named target, so it is an environment variable and not a
    // default.
    deployment.writable = process.env.AUDIT_WRITE === '1';
    if (!deployment.writable) {
      console.log('  targeting a live deployment in READ-ONLY mode (set AUDIT_WRITE=1 to let it create fixtures)');
    } else {
      console.log('  targeting a live deployment in WRITE mode: it will create users and deactivate them when it finishes');
    }

    // Read as the unpinned seat: a branch-pinned owner's list would only offer the one
    // branch they are pinned to, and a seat pinned to the wrong business is a fixture
    // that proves nothing about the scopes under test.
    const branchRes = await (deployment.admin || deployment.owner).get('/api/branches?limit=100');
    deployment.branches = ((branchRes.json && (branchRes.json.data || branchRes.json.branches)) || [])
      // A DEACTIVATED BRANCH IS NOT SOMEWHERE A SEAT CAN BE PINNED, and the product says
      // so: `409 BRANCH_INACTIVE — "Pair Owner Branch" is deactivated. Reactivate it under
      // Admin before trading through it.` A live audit run picks its branches from this
      // list, and on a deployment where an earlier run (or the client) closed a branch, the
      // one it picked was closed: the run stopped before its first check, on a rule it had
      // no business arguing with. An audit stands on the branches the shop actually uses.
      .filter((b) => b.is_active === undefined || Number(b.is_active) === 1);

    // THE FIXTURE'S OWN FIRST BRANCH GOES FIRST — AND SEATS PIN TO IT.
  //
  // This has to happen BEFORE the seats below are created, because a seat is pinned
  // with `deployment.branches[seat.branchIndex]`. With two branches and the API
  // ordering them alphabetically, a fixture whose intent was "branch 0 and branch 1"
  // produced a manager pinned to the SECOND shop while the audit traded at the
  // first — and the audit's own check that a manager cannot read another branch then
  // answered 200, which looked exactly like a scope leak and was a fixture that had
  // pinned the wrong person. Recorded by the local runner in deployment.primaryBranchId,
  // in insertion order, before the database was closed.
  if (deployment.primaryBranchId) {
    const primary = deployment.branches.find((b) => String(b.id) === String(deployment.primaryBranchId));
    if (primary) {
      deployment.branches = [primary, ...deployment.branches.filter((b) => String(b.id) !== String(primary.id))];
      console.log(`  the fixture's own first branch "${primary.name}" is branches[0]`);
    }
  }

  // PUT THE OWNER'S OWN BRANCHES FIRST.
    //
    // `GET /api/branches` reaches everything the caller can see, and on a deployment with
    // two businesses an OWNER — whose scope is "all branches" — gets both sets back in
    // whatever order the query returns. An audit that took `branches[0]` as its branch
    // then created its customer in one business and rang the sale at a branch of the
    // other, and the product refused it with CROSS_BUSINESS_CUSTOMER — correctly, and at
    // the sixth check of eight, which is a confusing way to learn it. Found by running
    // audit.money against staging, where the two businesses are real.
    //
    // The owner's own business is what an audit trading as that owner is trading in, and
    // the branch they are pinned to (if any) is the one they actually work at.
    const ownerBusiness = deployment.owner && deployment.owner.businessId;
    const pinned = deployment.owner && deployment.owner.branchId;
    if (ownerBusiness) {
      deployment.branches = deployment.branches.slice().sort((a, b) => {
        const score = (row) => (String(row.id) === String(pinned) ? 0 : (String(row.business_id) === String(ownerBusiness) ? 1 : 2));
        return score(a) - score(b);
      });
      console.log(`  the owner trades in business ${ownerBusiness}; its ${deployment.branches.filter((b) => String(b.business_id) === String(ownerBusiness)).length} branch(es) come first`);
    }

    // Seats, where the target allows them. A read-only run leaves `seats` empty and the
    // scope sections stand down with a reason rather than a false alarm — see
    // audit.http.js.
    for (const seat of seats) {
      if (!deployment.writable) break;
      const key = seat.as || String(seat.role || 'USER').toLowerCase();
      const branch = seat.branchIndex != null ? deployment.branches[seat.branchIndex] : null;
      if (seat.role !== 'ADMIN' && !branch) { console.log(`  no branch to pin the ${key} seat to — skipping it`); continue; }
      // A LIVE USER NEEDS A NAME THAT CANNOT COLLIDE. Locally the database is fresh on
      // every run, so `http-manager` is free. On a live deployment it is not free on
      // the second run — and a username is never reused, even by a deactivated user,
      // because their past sales are still attributed to them. The first live write run
      // therefore fails on run two with 409 DUPLICATE_USERNAME, which is correct
      // behaviour and a broken audit. The suffix is the fix.
      const suffix = Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 1296).toString(36);
      deployment.seats[key] = await deployment.seat({
        full_name: seat.full_name || `Audit ${key}`,
        username: `${(seat.username || `audit-${key}`).slice(0, 30)}-${suffix}`,
        pin: seat.pin || '73041',
        role: seat.role || 'MANAGER',
        branchId: branch ? branch.id : null,
        businessId: branch ? branch.business_id : null,
      });
      console.log(`  seated ${seat.role} "${deployment.seats[key].username}" at ${branch ? branch.name : 'no branch'}`);
    }
    return deployment;
  }

  const port = wantedPort || await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dbFile = path.join(os.tmpdir(), `stockridge-audit-${label}-${process.pid}-${Date.now()}.db`);

  for (const suffix of ['', '-wal', '-shm', '.jwt']) {
    try { fs.rmSync(dbFile + suffix, { force: true }); } catch (e) { /* absent */ }
  }

  const { openDatabase, migrate } = require(path.join(ROOT, 'server/lib/db'));
  const provisioning = require(path.join(ROOT, 'server/services/provisioningService'));

  const db = openDatabase({ file: dbFile });
  await migrate(db);

  if (businesses.length) {
    await provisioning.provisionDeployment(db, {
      businessName: businesses[0].name,
      profileCode: businesses[0].profileCode,
      ownerName: owner.name,
      ownerUsername: owner.username,
      ownerPin: owner.pin,
      adminUsername: admin.username,
      adminPin: admin.pin,
      branches: businesses[0].branches || [],
      vatRegistered: Boolean(businesses[0].vatRegistered),
    });
    // Further businesses belong to the same owner: that is the multi-business
    // shape, and it is provisioned the same way the app provisions one.
    for (const extra of businesses.slice(1)) {
      const { newId } = require(path.join(ROOT, 'domain/crypto'));
      const id = newId();
      await db.run(`INSERT INTO businesses (id, name, profile_code, vat_registered, created_at, updated_at)
                    VALUES (?,?,?,?, datetime('now'), datetime('now'))`,
      [id, extra.name, extra.profileCode, extra.vatRegistered ? 1 : 0]);
      for (const b of extra.branches || []) {
        const branchId = newId();
        await db.run(`INSERT INTO branches (id, business_id, name, code, city, state, branch_type, opening_cash, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
        [branchId, id, b.name, b.code, b.city || null, b.state || null, b.branch_type || 'RETAIL', b.opening_cash || 0]);
      }
      await provisioning.provisionBusiness(db, { id, profile_code: extra.profileCode });
    }
  } else if (withAdmin) {
    await provisioning.provisionPlatform(db, { adminUsername: admin.username, adminPin: admin.pin });
  }

  // WHICH BRANCH THIS FIXTURE MEANT AS ITS MAIN ONE, recorded in INSERTION order
  // before the database is closed.
  //
  // `GET /api/branches` returns branches in its own order — locally that is
  // alphabetical, so a fixture with `Wuse Shop` and `Kano Depot` reports Kano first.
  // Until this was recorded, `branchFor()` fell through to "the first branch of the
  // owner's business" and the audit silently moved from the shop whose safe it had
  // funded into the other one the moment a second branch was added to the fixture.
  // Nothing failed; the audit simply traded somewhere else, which is the sort of
  // thing that makes an audit's green tick hard to trust.
  let firstBranchId = null;
  try {
    const firstBusiness = await db.first('SELECT id FROM businesses WHERE is_deleted = 0 ORDER BY rowid LIMIT 1');
    if (firstBusiness) {
      const firstBranch = await db.first('SELECT id FROM branches WHERE business_id = ? AND is_deleted = 0 ORDER BY rowid LIMIT 1', [firstBusiness.id]);
      firstBranchId = firstBranch ? String(firstBranch.id) : null;
    }
  } catch (e) { firstBranchId = null; }
  await db.close();

  let log = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'server/app.js'), `--port=${port}`, `--db=${dbFile}`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d.toString(); if (process.env.AUDIT_SERVER_LOG) process.stderr.write(`[server] ${d.toString()}`); });
  // SERVER LOGS ON REQUEST. When a check dies on a 500 the child's stderr is where the
  // failing statement is named; without it a failing audit reports only the message the
  // error handler produced, which for a constraint is "a required value is missing" and
  // names no column and no table.
  child.stderr.on('data', (d) => { log += d.toString(); if (process.env.AUDIT_SERVER_LOG) process.stderr.write(`[server] ${d.toString()}`); });

  const deployment = new Deployment({ base, port, dbFile, child, log: () => log });
  deployment.primaryBranchId = firstBranchId;
  Object.defineProperty(deployment, 'serverLog', { get: () => log });

  const deadline = Date.now() + waitMs;
  let up = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) { up = true; break; }
    } catch (e) { /* not listening yet */ }
    if (child.exitCode !== null) break;
  }
  if (!up) {
    await deployment.close();
    throw new Error(`the audit server never became healthy on ${base}.\n${log.slice(-2000)}`);
  }

  if (businesses.length) {
    deployment.owner = await deployment.login({ username: owner.username, pin: owner.pin });
  }
  if (withAdmin || businesses.length) {
    try {
      deployment.admin = await deployment.login({ username: admin.username, pin: admin.pin });
    } catch (e) { deployment.admin = null; }
  }

  // THE BRANCHES, AS THE API REPORTS THEM, so a seat can be pinned to one. An audit
  // that needs a manager pinned to a branch must pin them to a branch id the server
  // agrees exists — a fixture id it invented would be a branch only the fixture can
  // see, and every scope assertion after it would be about nothing.
  const branchesRes = await (deployment.owner || deployment.admin).get('/api/branches?limit=100');
  deployment.branches = ((branchesRes.json && (branchesRes.json.data || branchesRes.json.branches)) || [])
    .filter((b) => b.is_active === undefined || Number(b.is_active) === 1);
  if (seats.length && !deployment.branches.length) throw new Error('seats were asked for but the deployment reports no branches to pin them to');

  // THE FIXTURE'S FIRST BRANCH GOES FIRST HERE TOO, before a seat is pinned to
  // `branches[branchIndex]`. The live path does this above; this path reloaded the
  // branches from the API and had lost the ordering, so a local run with two branches
  // pinned its manager to whichever branch the API listed first and the audit's own
  // scope refusal then answered 200 — a fixture bug wearing the costume of a scope leak.
  if (deployment.primaryBranchId) {
    const primary = deployment.branches.find((b) => String(b.id) === String(deployment.primaryBranchId));
    if (primary) {
      deployment.branches = [primary, ...deployment.branches.filter((b) => String(b.id) !== String(primary.id))];
      console.log(`  the fixture's own first branch \"${primary.name}\" is branches[0]`);
    }
  }

  // SEATS: real users, made through the real endpoint, so an audit can ask what a
  // manager sees rather than what an administrator sees. See Deployment.seat().
  deployment.seats = {};
  for (const seat of seats) {
    const key = seat.as || String(seat.role || 'USER').toLowerCase();
    const branch = seat.branchIndex != null ? (deployment.branches || [])[seat.branchIndex] : null;
    deployment.seats[key] = await deployment.seat({
      full_name: seat.full_name || `Audit ${key}`,
      username: seat.username || `audit-${key}`,
      pin: seat.pin || '73041',
      role: seat.role || 'MANAGER',
      branchId: seat.branchId || (branch && branch.id) || null,
      businessId: seat.businessId || null,
    });
  }
  // EVERY ACTOR SAYS WHO IT IS. See Deployment.describe() — the owner and the
  // administrator are described too, because an audit that asks "what can the owner
  // reach" needs the same answer the manager seats get.
  for (const actor of [deployment.owner, deployment.admin].filter(Boolean)) {
    await deployment.describe(actor);
  }
  return deployment;
}

module.exports = { startDeployment, freePort, Actor, Deployment, ROOT };
