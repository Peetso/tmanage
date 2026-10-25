import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../src/lib/i18n/messages/en.json';
import ar from '../src/lib/i18n/messages/ar.json';
import { activeLocale } from '../src/lib/i18n/locale-store';
import {
  PAGE_OWNS_TITLE,
  ROUTE_TITLES,
  TITLE_SUFFIX,
  matchRoutePattern,
} from '../src/lib/route-titles';
import { RouteDocumentTitle } from '../src/components/providers/RouteDocumentTitle';

let pathname = '/sign-in';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

/**
 * **Every route has its page name in the tab, in English and Arabic (live check f30af1d0, E1).**
 *
 * `/sign-in` and `/recover` showed a bare `TManage` tab in both languages. This walks every
 * `page.tsx` under `src/app` and fails on a route with no row in `ROUTE_TITLES`, a bare or
 * missing English name, a name with no Arabic in the catalogs, or a static `metadata.title` that
 * says something other than the row.
 */

const APP = join(__dirname, '..', 'src', 'app');
const EN: Record<string, string> = en;
const AR: Record<string, string> = ar;
const ARABIC = /[؀-ۿ]/;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === 'page.tsx' ? [path] : [];
  });
}

/** `src/app/(website)/features/work/page.tsx` → `/features/work`. */
function patternOf(file: string): string {
  const segments = relative(APP, file)
    .split(sep)
    .slice(0, -1)
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
  return `/${segments.join('/')}`;
}

const ROUTES = pages(APP).map((file) => ({ file, pattern: patternOf(file) }));

/** The static title a page or its own layout declares, as a literal or through `routeTitle`. */
function declaredTitle(file: string): { literal?: string; routeTitleOf?: string } {
  const sources = [file, join(file, '..', 'layout.tsx')].filter((path) => existsSync(path));
  for (const source of sources) {
    const text = readFileSync(source, 'utf8');
    const viaTable = /title:\s*routeTitle\('([^']+)'\)/.exec(text)?.[1];
    if (viaTable !== undefined) return { routeTitleOf: viaTable };
    const literal = /export const metadata[^=]*=\s*\{\s*title:\s*'([^']+)'/.exec(text)?.[1];
    if (literal !== undefined) return { literal };
  }
  return {};
}

describe('route titles', () => {
  it('walks every route', () => {
    expect(ROUTES.length).toBeGreaterThan(150);
    expect(Object.keys(ROUTE_TITLES).sort()).toEqual(ROUTES.map((r) => r.pattern).sort());
  });

  it.each(ROUTES)('$pattern has its page name in English and Arabic', ({ file, pattern }) => {
    const entry = ROUTE_TITLES[pattern];
    expect(entry, `no row for ${pattern}`).toBeDefined();
    if (entry === PAGE_OWNS_TITLE) {
      expect(readFileSync(file, 'utf8')).toMatch(
        /export (const metadata|async function generateMetadata)/,
      );
      return;
    }
    const row = entry!;
    expect(row.en.trim()).not.toBe('');
    expect(row.en).not.toBe('TManage');
    expect(EN[row.key], `${row.key} missing from en.json`).toBe(row.en);
    const arabic = AR[row.key];
    expect(arabic, `${row.key} missing from ar.json`).toBeDefined();
    expect(arabic).toMatch(ARABIC);

    const declared = declaredTitle(file);
    if (declared.literal !== undefined) expect(declared.literal).toBe(row.en);
    if (declared.routeTitleOf !== undefined) {
      // A layout's title also reaches its child routes, so it must be its own folder's route.
      expect(declared.routeTitleOf).toBe(pattern);
    }
  });

  it('matches a static segment before a workspace slug', () => {
    expect(matchRoutePattern('/features/work')).toBe('/features/work');
    expect(matchRoutePattern('/acme/work')).toBe('/[orgSlug]/work');
    expect(matchRoutePattern('/pricing')).toBe('/pricing');
    expect(matchRoutePattern('/acme')).toBe('/[orgSlug]');
    expect(matchRoutePattern('/acme/projects/new')).toBe('/[orgSlug]/projects/new');
    expect(matchRoutePattern('/acme/projects/p1')).toBe('/[orgSlug]/projects/[projectId]');
    expect(matchRoutePattern('/sign-in?next=%2Facme')).toBe('/sign-in');
  });
});

describe('RouteDocumentTitle', () => {
  afterEach(() => {
    act(() => activeLocale.set('en-US'));
  });

  it('names a bare route', () => {
    pathname = '/sign-in';
    document.title = 'TManage';
    act(() => activeLocale.set('en-US'));
    render(<RouteDocumentTitle />);
    expect(document.title).toBe(`Sign in${TITLE_SUFFIX}`);
  });

  it('writes the Arabic name and restores English when switched back', () => {
    pathname = '/pricing';
    document.title = `Pricing${TITLE_SUFFIX}`;
    act(() => activeLocale.set('ar-EG'));
    render(<RouteDocumentTitle />);
    expect(document.title).toBe(`${AR['WebsiteTitle.pricing']}${TITLE_SUFFIX}`);
    act(() => activeLocale.set('en-US'));
    expect(document.title).toBe(`Pricing${TITLE_SUFFIX}`);
  });

  it('leaves a title the page set itself', () => {
    pathname = '/acme/docs/d1';
    document.title = `Launch brief${TITLE_SUFFIX}`;
    render(<RouteDocumentTitle />);
    expect(document.title).toBe(`Launch brief${TITLE_SUFFIX}`);
  });
});
