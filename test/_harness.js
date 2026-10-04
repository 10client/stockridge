// =====================================================================
// test/_harness.js — shared test scaffolding
// =====================================================================
// Zero dependencies. A test suite in this project must be runnable with
// nothing but `node test/audit.x.js`, because the fastest way to make a suite
// nobody runs is to make it need a runner, a config file and an install step.

'use strict';

const state = { pass: 0, fail: 0, fails: [], section: '' };

function group(name) {
  state.section = name;
  console.log(`\n--- ${name} ---`);
}

function ok(name, condition, detail) {
  if (condition) {
    state.pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    state.fail += 1;
    const d = detail == null ? '' : (typeof detail === 'string' ? detail : safeJson(detail));
    state.fails.push(`${state.section}: ${name}${d ? ` (${d})` : ''}`);
    console.log(`  FAIL  ${name}${d ? `  -> ${d.slice(0, 300)}` : ''}`);
  }
}

function eq(name, actual, expected, note) {
  const a = safeJson(actual); const e = safeJson(expected);
  ok(name, a === e, note ? `${note}: got ${a}, want ${e}` : `got ${a}, want ${e}`);
}

function near(name, actual, expected, tolerance = 0.005) {
  ok(name, Math.abs(Number(actual) - Number(expected)) <= tolerance, `got ${actual}, want ${expected} (+/- ${tolerance})`);
}

function throwsCode(name, fn, code) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      ok(name, false, 'async function passed to throwsCode — use throwsCodeAsync');
      return r;
    }
    ok(name, false, 'did not throw');
  } catch (e) {
    ok(name, e.code === code || e.status === code, `got ${e.code || e.status}: ${e.message}`);
  }
}

async function throwsCodeAsync(name, fn, code) {
  try {
    await fn();
    ok(name, false, 'did not throw');
  } catch (e) {
    ok(name, e.code === code || e.status === code, `got ${e.code || e.status}: ${e.message}`);
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function summary(title) {
  console.log(`\n${'='.repeat(68)}`);
  console.log(`${title}: ${state.pass} passed, ${state.fail} failed`);
  if (state.fails.length) {
    console.log('\nFAILED:');
    for (const f of state.fails) console.log(` - ${f}`);
  }
  console.log('='.repeat(68));
  return state.fail;
}

function exit(title) {
  process.exit(summary(title) ? 1 : 0);
}

module.exports = { state, group, ok, eq, near, throwsCode, throwsCodeAsync, summary, exit, safeJson };
