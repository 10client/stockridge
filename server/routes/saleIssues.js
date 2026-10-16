'use strict';
// =====================================================================
// server/routes/saleIssues.js — FIX A FLAGGED SALE, THEN CLEAR IT
// =====================================================================
// Staff can correct a receipt they rang, and can fill a missing payment
// reference. A manager clears a late posting, a sale with no till, and a
// sync problem. An owner clears a sale that has no journal, and only by
// quoting the entry that covers it. Nobody deletes the sale from here.
// =====================================================================

const { HttpError } = require('../lib/http');
const saleIssues = require('../services/saleIssues');

function mount(app, base = '/api') {
  app.get(`${base}/sale-issues`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const status = ctx.req.queryParam('status') || 'OPEN';
    const saleId = ctx.req.queryParam('sale_id') || null;
    try {
      const data = await saleIssues.list(db, ctx, { status, saleId, scanFirst: !saleId });
      ctx.json({ ok: true, data, total: data.length });
    } catch (e) {
      if (saleIssues.missingTable(e)) {
        throw new HttpError('Flagged sales are not ready on this server yet. Reload in a minute.', { status: 503, code: 'SALE_ISSUES_UNAVAILABLE' });
      }
      throw e;
    }
  });

  app.post(`${base}/sale-issues/clear-matching`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const body = await ctx.req.json().catch(() => ({}));
    const result = await saleIssues.clearMatching(db, ctx, body || {});
    ctx.json({ ok: true, ...result });
  });

  app.post(`${base}/sale-issues/:id/correct`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const body = await ctx.req.json().catch(() => ({}));
    const issue = await saleIssues.correct(db, ctx, ctx.req.param('id'), body || {});
    ctx.json({ ok: true, issue });
  });

  app.post(`${base}/sale-issues/:id/clear`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const body = await ctx.req.json().catch(() => ({}));
    const issue = await saleIssues.clear(db, ctx, ctx.req.param('id'), body || {});
    ctx.json({ ok: true, issue });
  });
}

module.exports = { mount };
