'use strict';
// The loading treatment is one place on purpose. A later screen must not grow its
// own spinner, and the till numpad must not grow a lock: a cashier entering an
// amount cannot wait on a button that refuses the next digit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');

test('premium loading is central, and the till numpad is not locked', () => {
  assert.match(UI, /function beginPage\(/);
  assert.match(UI, /function beginControl\(/);
  assert.match(UI, /closest\('\.numpad'\)/);
  assert.match(APP, /ui\.beginPage\(/);
  assert.match(APP, /ui\.endPage\(/);
  assert.match(APP, /view === 'pos' \|\| hit\.route\.view === 'till'/);

  assert.match(CSS, /\.premium-veil/);
  assert.match(CSS, /button\.is-loading::after/);
  assert.match(CSS, /\.numpad button\.is-loading,\s*\.numpad button\.is-busy\s*\{[^}]*pointer-events:\s*auto/);

  const kind = UI.slice(UI.indexOf('function controlKind'), UI.indexOf('function holdMs'));
  assert.match(kind, /numpad/);
  assert.match(kind, /return 'press'/);
});

test('creating a business opens a form, and the verticals card stays on the page', () => {
  const admin = fs.readFileSync(path.join(ROOT, 'public/js/views/admin.js'), 'utf8');
  assert.equal(admin.includes('profileOptions'), false, 'the create form still names a list that was never defined, so the dialog never opens');
  assert.match(admin, /fillVerticalSelect\(form, go\)/);
  assert.match(admin, /class: 'vertical-grid'/);
  assert.match(CSS, /\.modal-root\s*\{[^}]*overflow:\s*auto/);
  assert.match(CSS, /\.modal\s*\{[^}]*max-width:\s*100%/);
  assert.match(CSS, /\.vertical-grid\s*\{[^}]*minmax\(240px,\s*1fr\)/);
});
