import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { liveRoutes } from '../../test/support/live-routes.js';
import { classifyRoute } from './route-census.js';

/**
 * 56-04 — the permission-map coverage census (SPEC 56 §56-04 control 2).
 *
 * Every signed-in route the 56-15 census classifies as `org`, `platform` or `session-only` must
 * have a row in `docs/security/permission-test-map.md` naming the test id that proves who may and
 * may not call it. A row is a table line whose first cell is the route key in backticks
 * (`` `GET /v1/…` ``) and whose last cell names at least one test id (`AUTH-…`). A new route
 * without a row fails here with the line to paste; a row for a route that no longer exists fails
 * too, so the map cannot rot into fiction.
 */

const MAP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/security/permission-test-map.md',
);
const TEST_ID = /\bAUTH-[0-9A-Z-]*[0-9]\b/;

/** `route key → test-id cell` for every route row in the map. */
export function mapRows(markdown: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*`((?:GET|POST|PUT|PATCH|DELETE) \/[^`]*)`\s*\|(.*)\|\s*$/.exec(line);
    if (m) rows.set(m[1] as string, (m[2] as string).split('|').at(-1)?.trim() ?? '');
  }
  return rows;
}

/** Census-classified signed-in routes without a row (or whose row names no test id). */
export function unmappedRoutes(
  routes: readonly { key: string; cls: string }[],
  rows: ReadonlyMap<string, string>,
): string[] {
  return routes
    .filter((r) => r.cls !== 'public' && !TEST_ID.test(rows.get(r.key) ?? ''))
    .map((r) => `| \`${r.key}\` | ${r.cls} | <test id> |`);
}

function classified(): { key: string; cls: string }[] {
  return liveRoutes().map((r) => {
    // An `@Public()` route belongs to the 56-15 census's PUBLIC_ROUTES registry, not to this map.
    if (r.isPublic) return { key: r.key, cls: 'public' };
    const cls = classifyRoute(r);
    return { key: r.key, cls: typeof cls === 'string' ? cls : 'unclassified' };
  });
}

describe('56-04 permission-map coverage census', () => {
  it('maps 100 % of org, platform and session-only routes to a test id', () => {
    const routes = classified();
    const signedIn = routes.filter((r) => r.cls !== 'public');
    expect(signedIn.length).toBeGreaterThan(900);
    const missing = unmappedRoutes(routes, mapRows(readFileSync(MAP, 'utf8')));
    expect(missing, `add these rows to permission-test-map.md:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no row for a route that no longer exists', () => {
    const live = new Set(classified().map((r) => r.key));
    const stale = [...mapRows(readFileSync(MAP, 'utf8')).keys()].filter((k) => !live.has(k));
    expect(stale).toEqual([]);
  });

  it('refuses a route without a row and a row without a test id', () => {
    const routes = [
      { key: 'GET /v1/organizations/:orgSlug/x', cls: 'org' },
      { key: 'GET /v1/platform/y', cls: 'platform' },
      { key: 'GET /v1/public/z', cls: 'public' },
    ];
    const rows = mapRows('| `GET /v1/platform/y` | platform | to do |\n');
    expect(unmappedRoutes(routes, rows)).toEqual([
      '| `GET /v1/organizations/:orgSlug/x` | org | <test id> |',
      '| `GET /v1/platform/y` | platform | <test id> |',
    ]);
  });
});
