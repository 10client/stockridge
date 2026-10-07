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
// WHY IT IS ALSO WRITTEN INTO THE ASSET URLS (`/js/views/purchase-orders.js?v=ridge-…`).
//
// It was not, and a live report proved why that is not enough: "on staging i tried to receive a
// purchase order of an iphone … i dont see a place for inputing the serial numbers". Staging was
// correct — the API answered `requires_serial: 1` for the line and the deployed worker was serving
// the fixed file — but the SCREEN was built from the previous `purchase-orders.js`.
//
// The shell is cached the moment it is fetched, and assets are served STALE-WHILE-REVALIDATE under
// their bare path: the cached copy goes out immediately and the new file only lands in the cache for
// the NEXT load. So the first load after any deploy runs the previous build. On a till that is never
// closed, or a browser whose worker has not swapped yet, that first load is the only load anyone
// sees — and a fix that shipped looks like a fix that never happened.
//
// A URL carrying the deploy's stamp cannot be answered from a cache keyed by the old one. The
// navigation is network-first, so the fresh HTML names fresh URLs, those are cache misses, and the
// new files arrive on the SAME load — even when an older worker is still in control. The service
// worker's own precache list is stamped in the same pass, so nothing is fetched twice and the
// offline shell is built from the files the page will actually ask for.
//
//   node tools/stamp-build.js            # stamp sw.js, app.js and index.html (and the SW shell list)
//   node tools/stamp-build.js --check    # non-zero if any of them disagree
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SW = path.join(ROOT, 'public', 'sw.js');
const APP = path.join(ROOT, 'public', 'js', 'app.js');
const INDEX = path.join(ROOT, 'public', 'index.html');

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
// The stamp as it appears in a URL: `?v=ridge-20261007-1411-ddf80bd`.
const URL_RE = /[?&]v=(ridge-[0-9]{8}-[0-9]{4}-[0-9a-z]+)/;

/** Every `/js/…` or `/css/…` URL an asset can be reached by, with the stamp stripped off. */
function bareAsset(pathname) {
  return /\.(?:js|css)$/i.test(pathname) && /^\/(?:js|css)\//.test(pathname);
}

/**
 * Put `stampValue` on every asset URL in a file, whichever way the file spells them:
 * `src="/js/app.js"` and `href="/css/app.css"` in the HTML, `'/js/util.js'` in the worker's
 * precache list. Idempotent — an existing stamp is replaced, never doubled.
 */
function stampAssetUrls(src, stampValue) {
  let out = src;
  // HTML attributes
  out = out.replace(/((?:src|href)=\")(\/(?:js|css)\/[^\"?#]+?)(?:\?v=[^\"&#]*)?\"/g,
    (m, attr, pathname) => (bareAsset(pathname) ? `${attr}${pathname}?v=${stampValue}\"` : m));
  // Quoted paths in JavaScript (the service worker's SHELL list)
  out = out.replace(/'(\/(?:js|css)\/[^'?#]+?)(?:\?v=[^'&]*)?'/g,
    (m, pathname) => (bareAsset(pathname) ? `'${pathname}?v=${stampValue}'` : m));
  return out;
}

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
  // ---- and every asset URL, so the new files arrive on the first load after the deploy
  for (const file of [INDEX, SW]) {
    const src = fs.readFileSync(file, 'utf8');
    const next = stampAssetUrls(src, stampValue);
    if (next !== src) { fs.writeFileSync(file, next); changed.push(path.relative(ROOT, file)); }
  }
  return { stampValue, changed };
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const problems = [];
    const a = readStamp(SW, SW_RE);
    const b = readStamp(APP, APP_RE);
    if (a !== b) {
      problems.push(`the service worker says ${a} and the app says ${b} — a browser would cache one build and report the other`);
    }
    // The URLs matter as much as the constants: an index.html naming bare paths is an index.html
    // that can be answered, entirely, from a cache holding last deploy's files.
    const indexSrc = fs.readFileSync(INDEX, 'utf8');
    const assets = indexSrc.match(/(?:src|href)=\"\/(?:js|css)\/[^\"]*\"/g) || [];
    const bare = assets.filter((t) => !URL_RE.test(t));
    if (bare.length) {
      problems.push(`${bare.length} asset URL(s) in public/index.html carry no build stamp, starting with ${bare[0]} — those can be served from a stale cache`);
    }
    const indexStamp = (URL_RE.exec(indexSrc) || [])[1] || null;
    if (indexStamp !== a) problems.push(`index.html is stamped ${indexStamp} while the worker is ${a}`);
    const swSrc = fs.readFileSync(SW, 'utf8');
    const shell = ((/const SHELL = \[([\s\S]*?)\];/).exec(swSrc) || [])[1] || '';
    const shellAssets = shell.match(/'(?:\/js\/|\/css\/)[^']*'/g) || [];
    const shellBare = shellAssets.filter((t) => !URL_RE.test(t));
    if (shellBare.length) {
      problems.push(`${shellBare.length} precached asset(s) in public/sw.js carry no build stamp, starting with ${shellBare[0]} — the offline shell would be built from files the page no longer asks for`);
    }
    if (problems.length) {
      console.error('stamp-build --check: the build is not consistent');
      for (const p of problems) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    console.log(`stamp-build: worker, app, index.html and the precache list all say ${a}`);
    process.exit(0);
  }
  const result = stamp();
  console.log(`stamp-build: ${result.stampValue}`);
  for (const f of result.changed) console.log(`  updated ${f}`);
  if (!result.changed.length) console.log('  (both files already carried this stamp)');
}

module.exports = { buildStamp, stamp };
