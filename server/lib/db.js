'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { openDatabase } = require('../db/adapter');

const DEFAULT_PATH = process.env.STOCKRIDGE_DB
  || path.join(__dirname, '..', '..', 'data', 'stockridge.db');

let instance = null;

async function db({ filename = DEFAULT_PATH, reset = false } = {}) {
  if (instance) return instance;
  if (reset && filename !== ':memory:' && fs.existsSync(filename)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(filename + suffix, { force: true }); } catch (_) { /* noop */ }
    }
  }
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  instance = await openDatabase({ file: filename, driver: process.env.STOCKRIDGE_DRIVER || 'auto' });
  return instance;
}

function resetInstance() {
  if (instance) { try { instance.close(); } catch (_) { /* noop */ } }
  instance = null;
}

module.exports = { db, resetInstance, DEFAULT_PATH };
