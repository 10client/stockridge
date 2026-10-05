'use strict';
// =====================================================================
// server/routes/health.js — LIVENESS, READINESS AND THE PWA MANIFEST
// =====================================================================
// Mounted before the auth guard, deliberately. A health endpoint that needs a
// token cannot be used by an uptime monitor, a load balancer or a container
// orchestrator — all of which ask "are you alive?" long before anybody has
// signed in.
//
// LIVENESS vs READINESS are different questions and are answered separately:
//   /api/health        is the process up and able to answer?
//   /api/health/ready  can it actually serve a shop? (database reachable,
//                      schema applied, provisioning done)
// A process can be alive and not ready — migrating, or pointed at a database it
// cannot open. Conflating the two means an orchestrator routes traffic to a
// server that will fail every sale.
// =====================================================================

const { schemaInfo, appliedMigrationCount } = require('../lib/schemaInfo');
const { watNow } = require('../../domain/time');

const STARTED_AT = Date.now();

function mount(app, base = '/api') {
  /** Liveness. Cheap, no database access, always 200 if the process answers. */
  app.get(`${base}/health`, (ctx) => {
    ctx.json({
      ok: true,
      status: 'up',
      service: 'stockridge',
      version: '1.0.0',
      time: watNow(),
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    });
  });

  /**
   * Readiness. Touches the database, so it can fail — and says why, because
   * "not ready" without a reason is a page nobody can act on at 2am.
   */
  app.get(`${base}/health/ready`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const problems = [];
    let info = null;
    let businesses = 0;
    let appliedMigrations = 0;

    try {
      // A real query, not a ping: some failures only appear when the database is
      // actually read.
      const probe = await db.scalar('SELECT 1');
      if (probe !== 1) problems.push('The database answered a probe query with an unexpected value.');
      info = await schemaInfo(db);
      // `_migrations` on Node, `d1_migrations` on Cloudflare — counting the
      // wrong table would report a healthy deployment as unmigrated.
      appliedMigrations = (await appliedMigrationCount(db)).count;
      businesses = await db.scalar('SELECT COUNT(*) FROM businesses WHERE is_active = 1 AND is_deleted = 0');
    } catch (e) {
      problems.push(`The database could not be reached: ${e.message}`);
    }

    if (info && info.tables < 50) problems.push(`The schema looks incomplete (${info.tables} tables found, expected at least 50). Run the migrations.`);
    if (appliedMigrations === 0) problems.push('No migrations have been applied. Run `npm run db:migrate`.');

    // NO BUSINESS YET IS NOT A FAULT — IT IS THE FIRST-RUN STATE.
    //
    // A deployment is handed over with one administrator and nothing else, on
    // purpose: the client's first act is to create THEIR business, and
    // provisioning builds the chart of accounts, categories and starter
    // catalogue from that. Reporting that state as a bare "not_ready" sends an
    // operator looking for a fault that is not there, and the old message
    // pointed at `npm run db:seed`, which on a handover deployment correctly
    // does nothing at all. It is still not READY TO TRADE — no shop can ring up
    // a sale without a business — so the status code is unchanged.
    const awaitingFirstBusiness = businesses === 0 && problems.length === 0;
    if (businesses === 0) {
      problems.push('No business has been created yet. Sign in as the platform administrator and create one: Businesses → Create a business. Provisioning builds the chart of accounts, categories, price lists and a starter catalogue for the vertical you choose.');
    }

    const ready = problems.length === 0;
    ctx.json({
      ok: ready,
      status: ready ? 'ready' : (awaitingFirstBusiness ? 'awaiting_first_business' : 'not_ready'),
      time: watNow(),
      database: info ? { tables: info.tables, views: info.views, indexes: info.indexes, migrations: appliedMigrations } : null,
      businesses,
      problems,
    }, ready ? 200 : 503);
  });

  /**
   * The PWA manifest, generated rather than checked in.
   *
   * A white-label product cannot ship a static manifest: the installed app's
   * name, short name and theme colour belong to the CLIENT, and a shop that
   * installs an app called "StockRidge" when their sign says "Ridge Furniture
   * Palace" has been sold something generic. Generating it from client_settings
   * means the install prompt shows their brand.
   */
  app.get(`${base}/manifest.json`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const settings = await db.first('SELECT business_name, logo_data_url FROM client_settings WHERE id = 1').catch(() => null);
    const name = (settings && settings.business_name) || 'StockRidge';
    // A short name has to fit under an icon; truncating mid-word looks broken,
    // so take the first word when the full name is too long.
    const shortName = name.length <= 14 ? name : (name.split(/\s+/)[0] || name).slice(0, 14);

    ctx.header('Cache-Control', 'public, max-age=3600');
    ctx.json({
      name,
      short_name: shortName,
      description: 'Stock, sales and accounts for Nigerian retail and wholesale — offline first.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#0f1720',
      theme_color: '#0f7a4d',
      categories: ['business', 'productivity', 'finance'],
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [
        { name: 'New sale', short_name: 'Sell', url: '/pos', description: 'Open the point of sale' },
        { name: 'Stock', short_name: 'Stock', url: '/stock', description: 'Check stock levels' },
        { name: 'Dashboard', short_name: 'Today', url: '/dashboard', description: "Today's trading" },
      ],
    });
  });
}

module.exports = { mount };
