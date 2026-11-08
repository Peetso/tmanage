// B18 (r47 L2) — the inline-script hashes of the prerendered pages, computed AT BUILD TIME.
//
// Runs after `next build` and the Arabic localisation step (package.json "build"), so it hashes
// the exact HTML `next start` will serve. It writes `<distDir>/csp-script-hashes.json`:
//
//   { "version": 1, "routes": { "/sign-in": ["sha256-…", …], … } }
//
// `src/lib/prerendered-script-hashes.ts` reads that file once per process and `src/proxy.ts` sends
// `script-src 'self'` plus those hashes for each listed path. Nobody copies a hash by hand; the
// live check compares the served header against this file. Only `page` routes that never
// revalidate are listed: their HTML cannot change while the process runs.
//
// `inlineScriptBodies` mirrors `src/lib/csp.ts`; `tests/csp-hashes-build.test.ts` holds the two to
// the same output so they cannot drift.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HASH_MANIFEST_FILE = 'csp-script-hashes.json';

/**
 * The text of every inline `<script>` in `html` (those without `src`), as the browser hashes it.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptBodies(html) {
  const bodies = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (!/\ssrc\s*=/i.test(attributes) && body !== '') bodies.push(body);
  }
  return bodies;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function sha256Source(text) {
  return `sha256-${createHash('sha256').update(text).digest('base64')}`;
}

/**
 * The manifest for the build in `distDir`. A static route whose HTML is missing is left out (the
 * proxy then keeps the nonce policy for it) and named in `missing`.
 *
 * @param {string} distDir
 * @param {(path: string) => string} [read]
 * @returns {{ manifest: { version: 1, routes: Record<string, string[]> }, missing: string[] }}
 */
export function buildHashManifest(distDir, read = (path) => readFileSync(path, 'utf8')) {
  const prerender = JSON.parse(read(join(distDir, 'prerender-manifest.json')));
  /** @type {Record<string, string[]>} */
  const routes = {};
  const missing = [];
  for (const [route, entry] of Object.entries(prerender.routes ?? {})) {
    if (entry?.routeType !== 'page' || entry?.initialRevalidateSeconds !== false) continue;
    const file = join(distDir, 'server', 'app', `${route === '/' ? '/index' : route}.html`);
    let html;
    try {
      html = read(file);
    } catch {
      missing.push(route);
      continue;
    }
    routes[route] = [...new Set(inlineScriptBodies(html).map(sha256Source))];
  }
  return { manifest: { version: 1, routes }, missing };
}

/** @param {string} distDir */
export function writeHashManifest(distDir) {
  const { manifest, missing } = buildHashManifest(distDir);
  writeFileSync(join(distDir, HASH_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { routes: Object.keys(manifest.routes).length, missing };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const here = fileURLToPath(new URL('..', import.meta.url));
  const distDir = resolve(here, process.env['TMANAGE_NEXT_DIST_DIR'] ?? '.next');
  const { routes, missing } = writeHashManifest(distDir);
  console.log(`csp-script-hashes: ${routes} prerendered page(s) hashed`);
  if (missing.length > 0) console.warn(`csp-script-hashes: no HTML for ${missing.join(', ')}`);
}
