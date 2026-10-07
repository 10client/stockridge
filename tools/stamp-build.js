#!/usr/bin/env node
'use strict';
// =====================================================================
// tools/stamp-build.js — ONE CACHE KEY PER DEPLOY
// =====================================================================
// `public/sw.js` names its cache after a BUILD constant and `public/js/app.js` carries the same
// stamp, and the service worker serves /js and /css CACHE-FIRST. Both constants were typed by hand,
// so they read `ridge-2` and `ridge-1` through every deploy after the one that wrote them: a browser
// that had already loaded the old bundle kept being handed the OLD bundle by its own service worker,
// with the new files on the server and no way for them to arrive. That is how a fixed screen comes
// back reported as broken — the owner clicks Account, the cached account.js runs, and the screen
// says "That failed. transfers is not defined" for code that has not been on the server for days.
//
// The stamp is the deploy's identity: the short commit and the minute it was made. Bumping it is
// what makes `activate` throw the old cache away.
//
//   node tools/stamp-build.js            # write the stamp into both files
//   node tools/stamp-build.js --check    # non-zero if the two files disagree
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SW = path.join(ROOT, 'public', 'sw.js');
const APP = path.join(ROOT, 'public', 'js', 'app.js');

function shortSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {
    return 'nogit';
  }
}

/** The stamp for this deploy: the commit that is going out, and the minute. */
function buildStamp(when = new Date()) {
  const iso = when.toISOString();
  return `ridge-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}-${shortSha()}`;
}

function readStamp(file, pattern) {
  const src = fs.readFileSync(file, 'utf8');
  const m = pattern.exec(src);
  return m ? m[1] : null;
}

const SW_RE = /const BUILD = '([^']+)';/;
const APP_RE = /SR\.BUILD = '([^']+)';/;

/** Write `stamp` into both files. Returns what changed. */
function stamp(stampValue = buildStamp()) {
  const changed = [];
  for (const [file, re, replacement] of [
    [SW, SW_RE, `const BUILD = '${stampValue}';`],
    [APP, APP_RE, `SR.BUILD = '${stampValue}';`],
  ]) {
    const src = fs.readFileSync(file, 'utf8');
    if (!re.test(src)) throw new Error(`stamp-build: no BUILD constant found in ${path.relative(ROOT, file)}`);
    const next = src.replace(re, replacement);
    if (next !== src) { fs.writeFileSync(file, next); changed.push(path.relative(ROOT, file)); }
  }
  return { stampValue, changed };
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const a = readStamp(SW, SW_RE);
    const b = readStamp(APP, APP_RE);
    if (a !== b) {
      console.error(`stamp-build: the service worker says ${a} and the app says ${b} — a browser would cache one build and report the other`);
      process.exit(1);
    }
    console.log(`stamp-build: both files say ${a}`);
    process.exit(0);
  }
  const result = stamp();
  console.log(`stamp-build: ${result.stampValue}`);
  for (const f of result.changed) console.log(`  updated ${f}`);
  if (!result.changed.length) console.log('  (both files already carried this stamp)');
}

module.exports = { buildStamp, stamp };
