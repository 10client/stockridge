// =====================================================================
// worker/src/assets.js — static serving on Workers
// =====================================================================
// The Node backend reads from public/ on disk. A Worker has no filesystem, so
// the same files are served from an ASSETS binding (Cloudflare's static asset
// upload) and, for the shell only, from an inlined fallback so the app still
// renders if the binding is missing.
//
// The headers MUST match the Node backend's. A deployment where one backend
// caches index.html and the other does not produces the worst kind of bug to
// diagnose: the same code behaves differently depending on which box the client
// was pointed at, and a stale shell loading new assets breaks in ways that look
// like a broken build rather than a cache policy.

'use strict';

import { SECURITY_HEADERS } from './http.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** HTML, the service worker and the manifest must never be cached hard: a client
 *  stuck on an old shell with new assets is a client whose app is broken in ways
 *  that look like a bug in the code. Assets can be cached for a day. */
function cacheControlFor(pathname) {
  if (pathname.endsWith('.html') || pathname === '/' || pathname.endsWith('sw.js')
    || pathname.endsWith('manifest.json') || pathname.endsWith('manifest.webmanifest')) {
    return 'no-cache, must-revalidate';
  }
  return 'public, max-age=86400';
}

/**
 * Serve a static asset, or null if there is none.
 *
 * Path traversal does not apply the way it does on a filesystem — the ASSETS
 * binding resolves against the uploaded manifest and there is no parent directory
 * to escape to — but the path is still normalised, because a binding that
 * accepted `../` would be a binding that could be pointed at another deployment's
 * assets.
 */
export async function serveAssetFromBinding(env, request, pathname, requestId) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  const normalised = normalisePath(pathname);
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(normalised, request.url).toString(), { method: 'GET' }));
    if (!res || res.status === 404) return null;
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', cacheControlFor(normalised));
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    if (requestId) headers.set('X-Request-Id', requestId);
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    // An asset-binding failure must not take the API down with it; the API is
    // what a till actually needs.
    console.error('[stockridge:worker] asset fetch failed', normalised, e && e.message);
    return null;
  }
}

function normalisePath(pathname) {
  let p = String(pathname || '/');
  if (!p.startsWith('/')) p = `/${p}`;
  // Collapse `..` and `.` segments. Decoding already happened upstream.
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  const joined = `/${out.join('/')}`;
  return joined === '/' ? '/index.html' : joined;
}

function extOf(pathname) {
  const m = String(pathname).match(/(\.[a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

export { MIME, cacheControlFor, extOf, normalisePath };

/**
 * A minimal shell used only when no ASSETS binding is configured, so the
 * deployment says something useful instead of returning a bare 404.
 *
 * It is deliberately NOT a copy of public/index.html. A second copy of the shell
 * is a second thing to keep in step, and the failure mode of getting it wrong is
 * a Worker serving an outdated login screen that cannot sign anybody in.
 */
export const SPA_SHELL = `<!DOCTYPE html>
<html lang="en-NG"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StockRidge — assets not deployed</title>
<style>
  body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f5;color:#14201c;margin:0;padding:3rem 1.25rem}
  main{max-width:38rem;margin:0 auto;background:#fff;border:1px solid #d8e0dc;border-radius:10px;padding:1.75rem}
  h1{font-size:1.3rem;margin:0 0 .5rem}
  code{background:#f2f6f4;border:1px solid #d8e0dc;border-radius:4px;padding:.1rem .35rem;font-size:.88em}
  pre{background:#f2f6f4;border:1px solid #d8e0dc;border-radius:6px;padding:.75rem;overflow-x:auto;font-size:.82rem}
  .ok{color:#0b6b4f;font-weight:600}
</style></head><body><main>
<h1>StockRidge is running, but its web assets are not deployed</h1>
<p class="ok">The API is live on this Worker.</p>
<p>The interface files under <code>public/</code> have not been uploaded, so there is no
login screen to serve. Add the static-asset binding to <code>worker/wrangler.toml</code>:</p>
<pre>[assets]
directory = "../public"
binding   = "ASSETS"
not_found_handling = "single-page-application"</pre>
<p>Then redeploy:</p>
<pre>npx wrangler deploy</pre>
<p>If you only want the API on this Worker — for example because the shop hosts the
interface on its own box and points it here — that is a supported setup. Point the
frontend's <code>PUBLIC_ORIGIN</code> at this Worker and enable CORS for that origin.</p>
</main></body></html>`;

export default serveAssetFromBinding;
