'use strict';
// The sequential probe failed two reads, and nothing else on the screen list.
// The hire book called query as a function. The dashboard asked an agreement
// for a deposit column that belongs to a till hold, not to a hire.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../../server/lib/http');

test('a query string can be read by name', async () => {
  const app = createApp();
  app.get('/api/agreements', async (ctx) => {
    ctx.json({
      called: ctx.req.query('status'),
      named: ctx.req.queryParam('status'),
      all: ctx.req.query(),
    });
  });
  const res = await app.fetch(new Request('http://localhost/api/agreements?status=OUT'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.called, 'OUT');
  assert.equal(body.named, 'OUT');
  assert.equal(body.all.status, 'OUT');
});

test('the dashboard reads the deposit an agreement holds', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server/routes/dashboard.js'), 'utf8');
  assert.equal(src.includes('a.deposit_amount'), false);
  assert.equal(src.includes('a.deposit_held'), true);
});

test('the hire book reads status the same way every other list does', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server/routes/agreements.js'), 'utf8');
  assert.equal(src.includes("ctx.req.query('status')"), false);
  assert.equal(src.includes("ctx.req.queryParam('status')"), true);
});
