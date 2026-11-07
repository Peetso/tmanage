import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inlineScriptBodies } from './csp';

/**
 * B18 — the inline-script hashes of the pages Next serves from build-time HTML.
 *
 * A prerendered page (the public site, sign-in, the platform console…) was rendered with no
 * request, so its scripts carry no nonce and the nonce policy reported every one of them. For
 * those paths `src/proxy.ts` sends `script-src 'self'` plus the SHA-256 of each inline script of
 * the exact HTML on disk (`<distDir>/server/app/<route>.html`).
 *
 * Only `page` routes that never revalidate are used: their HTML cannot change while the process
 * runs, so each file is read and hashed once. Anything unreadable — no manifest (`next dev`), a
 * missing file — answers `undefined`, and the request keeps the nonce policy.
 */

type ReadText = (path: string) => string;

interface PrerenderManifest {
  readonly routes?: Record<
    string,
    { readonly routeType?: string; readonly initialRevalidateSeconds?: number | false }
  >;
}

export function sha256Source(text: string): string {
  return `sha256-${createHash('sha256').update(text).digest('base64')}`;
}

/** `(pathname) => hashes | undefined`; reads lazily and caches per process. */
export function createPrerenderedScriptHashes(
  distDir: string,
  read: ReadText = (path) => readFileSync(path, 'utf8'),
): (pathname: string) => readonly string[] | undefined {
  let routes: Set<string> | undefined;
  const hashes = new Map<string, readonly string[] | undefined>();

  const staticRoutes = (): Set<string> => {
    if (routes !== undefined) return routes;
    routes = new Set();
    try {
      const manifest = JSON.parse(
        read(join(distDir, 'prerender-manifest.json')),
      ) as PrerenderManifest;
      for (const [route, entry] of Object.entries(manifest.routes ?? {})) {
        if (entry.routeType === 'page' && entry.initialRevalidateSeconds === false) {
          routes.add(route);
        }
      }
    } catch {
      // no build output (development) — every page keeps the nonce policy
    }
    return routes;
  };

  return (pathname) => {
    if (!staticRoutes().has(pathname)) return undefined;
    if (hashes.has(pathname)) return hashes.get(pathname);
    let found: readonly string[] | undefined;
    try {
      const file = join(distDir, 'server', 'app', `${pathname === '/' ? '/index' : pathname}.html`);
      found = inlineScriptBodies(read(file)).map(sha256Source);
    } catch {
      found = undefined;
    }
    hashes.set(pathname, found);
    return found;
  };
}
