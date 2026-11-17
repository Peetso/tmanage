import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import NotFound from '../src/app/not-found';
import ArabicNotFoundStaticPage from '../src/app/ar/(site)/page-not-found/page';
import { ALL_RESOURCES } from '../src/components/website/pages/resources/resources-data';
import { COMPARE_ENTRIES } from '../src/content/compare/compare-entries';
import { HELP_ARTICLES } from '../src/content/help/help-articles';
import { ARABIC_NOT_FOUND_PAGE, publicNotFoundPage } from '../src/lib/public-not-found';
import { proxy } from '../src/proxy';
import { LocaleStore } from '../src/lib/i18n/locale-store';
import { RouteLocaleProvider } from '../src/lib/i18n/route-locale';

vi.mock('next/navigation', () => ({
  usePathname: () => '/help/nope-xyz',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const ORIGIN = 'https://tmanageapp.com';
const UNKNOWN = 'nope-xyz';

/**
 * Public dynamic routes that answer an unknown segment some other way, never with `notFound()`.
 * `/resources/<x>` asks the public resources API and shows its own "not found" with a way back.
 */
const ANSWERED_ELSEWHERE = new Set(['/resources/[slug]']);

/** Every dynamic route of the public website (`(website)` and `ar`), as a URL pattern. */
function publicDynamicRoutes(): string[] {
  const app = join(process.cwd(), 'src/app');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.name.startsWith('[') ? [path, ...walk(path)] : walk(path);
      });
  return [join(app, '(website)'), join(app, 'ar')].flatMap(walk).map((dir) =>
    `/${relative(app, dir)
      .split(sep)
      .filter((segment) => !segment.startsWith('('))
      .join('/')}`.replace(/^\/\//, '/'),
  );
}

/** The route pattern with every dynamic segment filled with an unknown value. */
function probe(pattern: string): string {
  return pattern.replace(/\[\[?\.{0,3}[^\]]+\]\]?/g, UNKNOWN);
}

function request(path: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`);
}

/**
 * NEXTUP (live 2026-11-16): a `notFound()` thrown while a public page renders (`/help/nope`,
 * `/compare/nope`, `/ar/...`) answered 404 with an EMPTY body on Next 16.4.2 and 16.4.5 alike. The
 * proxy now answers every unknown public page with a prerendered not-found page, status 404.
 */
describe('an unknown page of the public website', () => {
  it('walks every public dynamic route: 404 and a not-found page with its content', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'same-origin');
    const routes = publicDynamicRoutes().filter((route) => !ANSWERED_ELSEWHERE.has(route));
    expect(routes.length).toBeGreaterThanOrEqual(6);
    const pages: Record<string, string> = {
      [`${ORIGIN}/_not-found`]: renderToString(<NotFound />),
      [`${ORIGIN}${ARABIC_NOT_FOUND_PAGE}`]: renderToString(
        // As `app/ar/layout.tsx` renders it: under the Arabic route locale.
        <RouteLocaleProvider locale="ar-EG" store={new LocaleStore('ar-EG')}>
          <ArabicNotFoundStaticPage />
        </RouteLocaleProvider>,
      ),
    };
    const answers = routes.map((route) => {
      const response = proxy(request(probe(route)));
      const page = pages[response.headers.get('x-middleware-rewrite') ?? ''] ?? '';
      const heading = /<h1[^>]*>([^<]+)<\/h1>/.exec(page)?.[1] ?? '';
      return { route, status: response.status, heading };
    });
    expect(answers).toEqual(
      routes.map((route) => ({
        route,
        status: 404,
        heading: route.startsWith('/ar') ? 'لم نعثر على هذه الصفحة' : 'We couldn’t find that page',
      })),
    );
  });

  it('answers any unknown /ar path, deep ones included, with the Arabic page', () => {
    expect(
      ['/ar/nope-xyz', '/ar/help/a/b', '/ar/page-not-found', '/ar/sign-in/nope'].map((path) =>
        publicNotFoundPage(path, true),
      ),
    ).toEqual([
      ARABIC_NOT_FOUND_PAGE,
      ARABIC_NOT_FOUND_PAGE,
      ARABIC_NOT_FOUND_PAGE,
      ARABIC_NOT_FOUND_PAGE,
    ]);
  });

  it('leaves every page that exists alone', () => {
    const help = HELP_ARTICLES[0]!.slug;
    const compare = COMPARE_ENTRIES[0]!.slug;
    const resource = ALL_RESOURCES[0]!.slug;
    expect(
      [
        '/help',
        `/help/${help}`,
        '/compare',
        `/compare/${compare}`,
        `/resources/${resource}`,
        '/resources/nope-xyz',
        '/ar',
        '/ar/pricing',
        '/ar/features/work',
        '/ar/sign-in',
        '/ar/help',
        `/ar/help/${help}`,
        `/ar/compare/${compare}`,
        `/ar/resources/${resource}`,
        '/pricing',
        '/website-kit',
      ].map((path) => publicNotFoundPage(path, false)),
    ).toEqual(Array.from({ length: 16 }, () => undefined));
  });

  it('answers the website kit as missing in production, where the page calls notFound()', () => {
    expect([
      publicNotFoundPage('/website-kit', true),
      publicNotFoundPage('/website-kit', false),
    ]).toEqual(['/_not-found', undefined]);
  });

  it('keeps the CSP of a rewritten not-found page (nonce, Trusted Types)', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'same-origin');
    const known = proxy(request('/pricing')).headers;
    const missing = proxy(request('/help/nope-xyz')).headers;
    const policy = (headers: Headers) =>
      (
        headers.get('content-security-policy') ??
        headers.get('content-security-policy-report-only') ??
        ''
      )
        .replace(/'nonce-[^']+'/g, "'nonce'")
        .replace(/'sha256-[^']+'/g, '');
    expect(policy(missing)).toBe(policy(known));
  });
});
