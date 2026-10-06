'use strict';
// =====================================================================
// test/audit/lib/harness.js — ONE WAY TO REPORT, ONE WAY TO ASK TWICE
// =====================================================================
// PharmaRidge's audit suite is a directory of scripts that each own one domain,
// run against a LIVE server, and report the same way. The value is in the
// uniformity: a reader can open any audit file and know what the output means,
// and the runner can run them all without knowing what any of them do.
//
// This is that shared part. Three things live here and nothing else:
//
//   1. THE REPORT. `check`, `section`, `pass`, `fail`, `report` — a stable
//      ✓/✗/⊘ format with counts and an exit code, so a failing audit fails a
//      script rather than printing a paragraph somebody has to read.
//
//   2. THE ACTOR. `actor('owner')` signs in once and remembers the token, so an
//      audit reads as the business it is auditing: `await owner.post('/api/…')`.
//      A role that cannot sign in FAILS — it does not skip. (PharmaRidge's trap
//      18: "a probe that SKIPS is a probe that lies.")
//
//   3. TWO-WAY. `acted()` and `read()` are deliberately two calls, because the
//      defect this whole form exists to catch is a write that reports success and
//      a read that never sees it. `twoWay()` makes that the easy thing to write:
//
//        await money.twoWay('a cash sale of ₦100',
//          () => till.post('/api/sales', { … }),
//          () => till.get('/api/tills/current'),
//          (after) => { assert.equal(after.expected_cash, 100); });
//
// WHAT IT IS NOT. There is no assertion library, no mocking and no fake server.
// An audit that mocks the thing it is auditing has stopped being an audit — every
// defect worth catching in this project so far lived in the plumbing BETWEEN two
// real components, where a mock would have agreed with the wrong one.
// =====================================================================

const assert = require('node:assert');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

class Audit {
  constructor(title, { subsystem = null } = {}) {
    this.title = title;
    this.subsystem = subsystem;
    this.results = [];
    this.notes = [];
    this.sectionName = null;
    this.started = Date.now();
  }

  /** A heading. Sections exist so a failure says WHERE it happened as well as what. */
  section(name) {
    this.sectionName = name;
    console.log(`\n${name}`);
    console.log('─'.repeat(64));
  }

  pass(what, detail) {
    this.results.push({ pass: true, section: this.sectionName, what });
    console.log(`  ${GREEN}✓${OFF} ${what}${detail ? `\n      ${DIM}${detail}${OFF}` : ''}`);
  }

  fail(what, detail) {
    this.results.push({ pass: false, section: this.sectionName, what, detail });
    console.log(`  ${RED}✗${OFF} ${what}${detail ? `\n      ${detail}` : ''}`);
  }

  skip(what, detail) {
    this.results.push({ pass: true, skip: true, section: this.sectionName, what });
    console.log(`  ${DIM}⊘ ${what}${detail ? ` — ${detail}` : ''}${OFF}`);
  }

  /**
   * Assert, and record which way it went. The message is the assertion message.
   *
   * A CHECK THAT REPORTS ITSELF IS NOT ALSO COUNTED AS A PASS. A check whose body
   * decides there is nothing to assert on — no second branch to try to reach into, no
   * non-ASCII value to carry back — calls `this.skip(...)` and returns. That used to
   * print a skip AND record a pass, which is worse than it sounds: the summary count
   * grew for a check that asserted nothing, so a suite could look more thorough the
   * less it was actually testing. The count is now what the check did.
   */
  check(what, fn) {
    const before = this.results.length;
    try {
      fn();
    } catch (err) {
      this.fail(what, err && err.message ? err.message : String(err));
      return false;
    }
    if (this.results.length > before) return null; // it reported itself — usually a skip
    this.pass(what);
    return true;
  }

  /** Assert something asynchronous, with the same reporting. */
  async checkAsync(what, fn) {
    const before = this.results.length;
    try {
      await fn();
    } catch (err) {
      this.fail(what, err && err.message ? err.message : String(err));
      return false;
    }
    if (this.results.length > before) return null;
    this.pass(what);
    return true;
  }

  /**
   * SAY SOMETHING WITHOUT CLAIMING ANYTHING.
   *
   * An audit that only ever prints passes and failures throws away the two most
   * useful things it learns: a DIFFERENCE between two backends that is not a
   * defect, and the EVIDENCE behind a passing check. A note prints in the middle of
   * a run, is not counted, and cannot make a run green or red — the moment it could
   * do either, the suite would start reporting opinions as facts.
   *
   *   audit.note('the charset comes from the document here, not the header')
   *
   * Notes are collected as well as printed, so a report can show them next to the
   * check that produced them when a run needs reading after the fact.
   */
  note(text) {
    const line = String(text);
    this.notes.push({ section: this.sectionName, text: line });
    console.log(`      ${DIM}· ${line}${OFF}`);
    return line;
  }

  /**
   * ACT, THEN LOOK.
   *
   * `do` performs the change; `look` reads the affected state back over HTTP; and
   * `expect` asserts on what the second call returned. The point of the shape is
   * that the assertion can only see the SERVER's view — never the object the first
   * call returned, which is the thing a broken endpoint gets right.
   */
  async twoWay(what, doIt, look, expect) {
    // `look` is optional. When the action's own response IS the thing to inspect,
    // pass the expectation third and leave the reader out:
    //   twoWay('a 401 without a token', () => d.request('GET', '/api/products'),
    //          (res) => assert.equal(res.status, 401))
    const reader = typeof look === 'function' && typeof expect === 'function' ? look : null;
    const expectation = reader ? expect : look;
    if (typeof expectation !== 'function') throw new Error('twoWay needs an expectation');
    let action;
    try {
      action = await doIt();
    } catch (err) {
      this.fail(`${what} — the action itself failed`, err && err.message ? err.message : String(err));
      return null;
    }
    if (action && action.status >= 400) {
      const body = action.json || {};
      this.fail(`${what} — refused with ${action.status}`, `${body.error || body.message || action.text.slice(0, 200)}`);
      return null;
    }
    let after;
    try {
      after = reader ? await reader(action) : action;
    } catch (err) {
      this.fail(`${what} — could not read the effect back`, err && err.message ? err.message : String(err));
      return null;
    }
    try {
      expectation(after, action);
      this.pass(what);
    } catch (err) {
      this.fail(`${what} — the effect does not match`, err && err.message ? err.message : String(err));
    }
    return after;
  }

  /**
   * EXPECT A REFUSAL, AND CHECK IT IS THE RIGHT ONE.
   *
   * Half of what makes this system safe is what it will not do, so "it said no"
   * is an assertion as important as "it said yes" — and a REFUSAL FOR THE WRONG
   * REASON is the failure mode worth catching. A cashier who is blocked from
   * voiding because of a missing token, rather than because the role may not, has
   * just been told a lie about their permissions and will ask support.
   *
   * `expectStatus` and `code` are both asserted when given.
   */
  async refusal(what, doIt, { expectStatus = null, code = null, message = null } = {}) {
    let res;
    try {
      res = await doIt();
    } catch (err) {
      this.fail(`${what} — the call itself threw`, err && err.message ? err.message : String(err));
      return null;
    }
    try {
      if (expectStatus != null) {
        assert.equal(res.status, expectStatus,
          `answered ${res.status}, expected ${expectStatus} — ${res.json && (res.json.error || res.json.message) ? res.json.error || res.json.message : String(res.text).slice(0, 120)}`);
      } else {
        assert.ok(res.status >= 400, `it SUCCEEDED with ${res.status}: ${String(res.text).slice(0, 160)}`);
      }
      if (code) assert.match(String((res.json || {}).code || ''), code, `refused with code "${(res.json || {}).code}", expected ${code}`);
      if (message) {
        const said = String((res.json || {}).error || (res.json || {}).message || '');
        assert.match(said, message, `refused, but the message was "${said}" — a refusal has to tell a cashier what to do next`);
      }
      this.pass(what, `${res.status} ${(res.json || {}).code || ''} ${String((res.json || {}).error || '').slice(0, 90)}`.trim());
      return res;
    } catch (err) {
      this.fail(what, err && err.message ? err.message : String(err));
      return res;
    }
  }

  /**
   * RUN SOMETHING AND KEEP THE VALUE, WITH THE FAILURE REPORTED.
   *
   * `check` answers "did it pass"; this answers "what was it", so a value can be
   * carried into the next assertion — the manifest's URL, an id, a computed figure.
   * On failure it records and returns `null`, so the caller has to handle the
   * absent value rather than crashing three lines later with a TypeError that
   * hides the real failure.
   */
  capture(what, fn) {
    try {
      const value = fn();
      this.pass(what, typeof value === 'string' ? value : undefined);
      return value;
    } catch (err) {
      this.fail(what, err && err.message ? err.message : String(err));
      return null;
    }
  }

  async captureAsync(what, fn) {
    try {
      const value = await fn();
      this.pass(what, typeof value === 'string' ? value : undefined);
      return value;
    } catch (err) {
      this.fail(what, err && err.message ? err.message : String(err));
      return null;
    }
  }

  /** The summary and the exit code. Called by `runAudit` even when the audit threw. */
  report() {
    // (notes never alter `total`/`failed` — see note())
    const failed = this.results.filter((r) => !r.pass);
    const skipped = this.results.filter((r) => r.skip);
    const secs = ((Date.now() - this.started) / 1000).toFixed(1);
    console.log(`\n${'═'.repeat(64)}`);
    if (failed.length) {
      console.log(`${RED}${this.title}: ${failed.length} FAILED${OFF} of ${this.results.length} checks (${secs}s)`);
      for (const f of failed) console.log(`  ✗ ${f.section ? `${f.section}: ` : ''}${f.what}${f.detail ? `\n      ${f.detail}` : ''}`);
    } else {
      console.log(`${GREEN}${this.title}: ${this.results.length - skipped.length} checks passed${OFF}${skipped.length ? `, ${skipped.length} reported` : ''} (${secs}s)`);
    }
    return { total: this.results.length, failed: failed.length, skipped: skipped.length };
  }
}

/**
 * Run one audit with the house's conventions: print a banner, run it, report, and
 * exit non-zero on a failure. A thrown error is a failure of the AUDIT, reported
 * as such — never a stack trace with no summary over it.
 *
 *   runAudit('money', async (audit, deployment) => { … });
 */
function runAudit(name, fn, { setup } = {}) {
  const audit = new Audit(`audit.${name}`);
  const started = Date.now();
  console.log(`\nStockRidge — audit.${name}`);
  console.log('='.repeat(64));
  (async () => {
    let deployment = null;
    try {
      if (setup) deployment = await setup(audit);
      await fn(audit, deployment);
    } catch (err) {
      audit.fail('the audit ran to the end', `${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`);
    } finally {
      if (deployment && typeof deployment.close === 'function') {
        try { await deployment.close(); } catch (e) { /* the audit's result matters more */ }
      }
      const summary = audit.report();
      console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);
      process.exit(summary.failed ? 1 : 0);
    }
  })();
}

module.exports = { Audit, runAudit, assert };
