import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAddressableWorkspaceSlug } from '@tmanage/domain';
import { NOT_FOUND_PAGE } from './workspace-gate';

/**
 * SMALLFIX 4 — every 404 the server would render at request time is answered with the
 * prerendered not-found page instead.
 *
 * A request-time 404 (an address no route takes, or the `[orgSlug]` layout's `notFound()`) reaches
 * the browser as HTML with an empty body: the not-found screen travels in the flight data and is
 * drawn by a chunk loaded at runtime, and that load is refused by the page's Trusted Types rule
 * (`require-trusted-types-for 'script'`), so the visitor sees a white page (live 2026-11-17,
 * `/confirm-email`). The prerendered `/_not-found` holds the whole screen in its HTML, so
 * `src/proxy.ts` rewrites these requests to it with status 404, under that page's own CSP hashes.
 *
 * Which addresses exist is Next's own table (`routes-manifest.json` of the build): static routes
 * first, then the dynamic ones in Next's matching order. Nothing from the request reaches a
 * regular expression's source: only the build's patterns are compiled.
 */

export const ROUTES_MANIFEST_FILE = 'routes-manifest.json';

interface ManifestRoute {
  readonly page: string;
  readonly regex: string;
}

interface RoutesManifest {
  readonly staticRoutes?: readonly ManifestRoute[];
  readonly dynamicRoutes?: readonly ManifestRoute[];
}

export interface RouteTable {
  readonly staticRoutes: readonly RegExp[];
  /** In Next's matching order: the first that matches is the route that renders. */
  readonly dynamicRoutes: readonly { readonly page: string; readonly regex: RegExp }[];
}

/** The workspace route: its layout 404s an address that is not a workspace slug. */
const WORKSPACE_ROUTE = '/[orgSlug]';

/** The route table of a `routes-manifest.json` text, or `undefined` when it cannot be read. */
export function parseRouteTable(text: string): RouteTable | undefined {
  try {
    const manifest = JSON.parse(text) as RoutesManifest;
    if (!Array.isArray(manifest.staticRoutes) || !Array.isArray(manifest.dynamicRoutes)) {
      return undefined;
    }
    // Next writes these patterns for non-unicode matching (`\-` escapes), as it runs them itself.
    return {
      staticRoutes: manifest.staticRoutes.map((route) => new RegExp(route.regex)),
      dynamicRoutes: manifest.dynamicRoutes.map((route) => ({
        page: route.page,
        regex: new RegExp(route.regex),
      })),
    };
  } catch {
    return undefined;
  }
}

/**
 * The prerendered not-found page `pathname` is answered with, or `undefined` when a route takes
 * it: none matches, or the first that matches is the workspace route and the first segment can
 * never be a workspace address (`/confirm-email`, `/wp-admin`). Signed in or out alike.
 */
export function unroutedNotFoundPage(pathname: string, table: RouteTable): string | undefined {
  if (table.staticRoutes.some((regex) => regex.test(pathname))) return undefined;
  const route = table.dynamicRoutes.find((candidate) => candidate.regex.test(pathname));
  if (route === undefined) return NOT_FOUND_PAGE;
  if (route.page !== WORKSPACE_ROUTE && !route.page.startsWith(`${WORKSPACE_ROUTE}/`)) {
    return undefined;
  }
  const slug = pathname.split('/')[1] ?? '';
  return isAddressableWorkspaceSlug(slug) ? undefined : NOT_FOUND_PAGE;
}

/**
 * `(pathname) => not-found page | undefined` for the build in `distDir`; reads the manifest once
 * per process. No manifest (`next dev`) or a malformed one answers `undefined` for every path, so
 * Next renders as before.
 */
export function createUnroutedNotFound(
  distDir: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): (pathname: string) => string | undefined {
  let table: RouteTable | null | undefined;
  return (pathname) => {
    if (table === undefined) {
      try {
        table = parseRouteTable(read(join(distDir, ROUTES_MANIFEST_FILE))) ?? null;
      } catch {
        table = null;
      }
    }
    return table === null ? undefined : unroutedNotFoundPage(pathname, table);
  };
}
