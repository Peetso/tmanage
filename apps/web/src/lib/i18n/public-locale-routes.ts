import type { Metadata } from 'next';
import { ALTERNATIVE_SLUGS } from '../../content/alternatives/alternative-slugs';
import { RESOURCE_SLUGS } from '../../components/website/pages/resources/resource-slugs';
import { COMPARE_SLUGS, SWITCH_SLUGS } from '../../content/compare/compare-slugs';
import { HELP_SLUGS } from '../../content/help/help-slugs';
import type { DisplayLocale } from '../api/display-preferences';
import { homePageTitle, PAGE_OWNS_TITLE, ROUTE_TITLES, TITLE_SUFFIX } from '../route-titles';
import { siteDescription } from './locale-html';
import { translate, type MessageKey } from './t';

/**
 * NFR-02 — the public website in Arabic at its own URLs (audit 2026-10-25b, gap 5).
 *
 * The root layout reads no request, so every page used to be prerendered `lang="en" dir="ltr"` with
 * English text and the visitor's Arabic was applied in the browser after the first paint. Each
 * public page now also exists under {@link ARABIC_PREFIX} (`/pricing` → `/ar/pricing`, `/` →
 * `/ar`), prerendered in Arabic (`app/ar/[[...path]]`): Arabic text and title in the HTML, and
 * `lang="ar" dir="rtl"` on `<html>` (`scripts/localize-prerendered-html.mjs`, after `next build`).
 * Both stay static, so the CDN keeps caching them (`apps/server/cache-headers.mjs`). The signed-in
 * app is not affected: only the paths listed here have an Arabic twin.
 */

/** The path prefix of the Arabic public pages. */
export const ARABIC_PREFIX = '/ar';

/** The locale an Arabic public page is rendered in. */
export const ARABIC_ROUTE_LOCALE: DisplayLocale = 'ar-EG';

/** Every public website page that has an Arabic twin (the `(website)` group, articles aside). */
export const PUBLIC_LOCALIZED_PATHS = [
  '/',
  '/about',
  '/accessibility',
  '/changelog',
  '/client-portal',
  '/contact',
  '/customers',
  '/developers',
  '/download',
  '/faq',
  '/features/communication',
  '/features/insights',
  '/features/knowledge',
  '/features/work',
  '/integrations',
  '/legal/privacy',
  '/legal/terms',
  '/pricing',
  '/product',
  '/resources',
  '/security',
  '/security/data-location',
  '/security/disclosure',
  '/solutions/agencies',
  '/solutions/consultancies',
  '/solutions/in-house',
  '/status',
] as const;

export type PublicLocalizedPath = (typeof PUBLIC_LOCALIZED_PATHS)[number];

const LOCALIZED: ReadonlySet<string> = new Set(PUBLIC_LOCALIZED_PATHS);

/** True when `path` (no query or hash) is a public page with an Arabic twin. */
export function isLocalizablePath(path: string | null | undefined): path is PublicLocalizedPath {
  return typeof path === 'string' && LOCALIZED.has(path);
}

/**
 * The sign-in and sign-up pages, which also have an Arabic twin (`/ar/sign-in`, `/ar/sign-up`):
 * the same screens and API, rendered right to left in Arabic. Not website pages, so they are not in
 * {@link PUBLIC_LOCALIZED_PATHS} (the catch-all's table) and get no website chrome.
 */
export const ARABIC_AUTH_PATHS = ['/sign-in', '/sign-up'] as const;

export type ArabicAuthPath = (typeof ARABIC_AUTH_PATHS)[number];

/**
 * The sign-in form, in both languages, is kept out of search results (a form answers no search):
 * `noindex`, and so left out of `sitemap.xml`, which lists only pages meant to be indexed (SEOFIX,
 * 2026-11-17). Sign-up is the site's call to action and stays indexed.
 */
export const NOINDEX_AUTH_PATHS: readonly ArabicAuthPath[] = ['/sign-in'];

/** The `robots` metadata of an auth page and of its Arabic twin. */
export function authPageRobots(path: ArabicAuthPath): NonNullable<Metadata['robots']> {
  return NOINDEX_AUTH_PATHS.includes(path)
    ? { index: false, follow: false }
    : { index: true, follow: true };
}

/*
 * The article, help, compare, switch and alternative paths are built from slug-only lists (SEOE): this module
 * runs in the browser on every public page, and the full content must not come with it.
 */

/** Every article of the resources library (`/resources/<slug>`), which has an Arabic twin. */
export const ARTICLE_PATHS: readonly string[] = RESOURCE_SLUGS.map((slug) => `/resources/${slug}`);

/** The Help centre (row 55-16) and its articles, each with an Arabic twin under `/ar/help`. */
export const HELP_PATHS: readonly string[] = [
  '/help',
  ...HELP_SLUGS.map((slug) => `/help/${slug}`),
];

/** The compare pages (row 57-06) and their index, each with an Arabic twin under `/ar/compare`. */
export const COMPARE_PATHS: readonly string[] = [
  '/compare',
  ...COMPARE_SLUGS.map((slug) => `/compare/${slug}`),
];

/** The "switch from X" pages (row 54-29), each with an Arabic twin under `/ar/switch`. */
export const SWITCH_PATHS: readonly string[] = SWITCH_SLUGS.map((slug) => `/switch/${slug}`);

/** The "X alternative" pages and their index (SEOF, B1), each with a twin under `/ar/alternatives`. */
export const ALTERNATIVE_PATHS: readonly string[] = [
  '/alternatives',
  ...ALTERNATIVE_SLUGS.map((slug) => `/alternatives/${slug}`),
];

/** The facts page (SEOF, B7), with its twin at `/ar/facts`. */
export const FACTS_PATH = '/facts';

const WITH_TWIN: ReadonlySet<string> = new Set<string>([
  ...PUBLIC_LOCALIZED_PATHS,
  ...ARABIC_AUTH_PATHS,
  ...ARTICLE_PATHS,
  ...HELP_PATHS,
  ...COMPARE_PATHS,
  ...SWITCH_PATHS,
  ...ALTERNATIVE_PATHS,
  FACTS_PATH,
]);

/**
 * True when `path` (no query or hash) has an Arabic twin under `/ar`: a website page, sign-in,
 * sign-up or a library article.
 */
export function hasArabicTwin(path: string | null | undefined): path is string {
  return typeof path === 'string' && WITH_TWIN.has(path);
}

/** The Arabic twin of any path {@link hasArabicTwin} accepts (`/sign-in` → `/ar/sign-in`). */
export function arabicTwinPath(path: string): string {
  return path === '/' ? ARABIC_PREFIX : `${ARABIC_PREFIX}${path}`;
}

/** True for `/ar` and everything under `/ar/`. */
export function isArabicPublicPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false;
  return pathname === ARABIC_PREFIX || pathname.startsWith(`${ARABIC_PREFIX}/`);
}

/** The English page an Arabic path mirrors (`/ar/pricing` → `/pricing`, `/ar` → `/`). */
export function englishPublicPath(pathname: string): string {
  if (!isArabicPublicPath(pathname)) return pathname;
  const rest = pathname.slice(ARABIC_PREFIX.length);
  return rest === '' || rest === '/' ? '/' : rest;
}

/** The Arabic twin of an English public path (`/pricing` → `/ar/pricing`, `/` → `/ar`). */
export function arabicPublicPath(path: PublicLocalizedPath): string {
  return path === '/' ? ARABIC_PREFIX : `${ARABIC_PREFIX}${path}`;
}

/** `/ar/features/work` → `['features', 'work']`, `/ar` → `[]`: the catch-all's params. */
export function segmentsOf(path: PublicLocalizedPath): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** The English public path the catch-all's segments name, or `undefined` for any other. */
export function pathFromSegments(
  segments: readonly string[] | undefined,
): PublicLocalizedPath | undefined {
  const path = `/${(segments ?? []).join('/')}`;
  return isLocalizablePath(path) ? path : undefined;
}

function splitHref(href: string): { path: string; rest: string } {
  const cut = href.search(/[?#]/);
  return cut === -1
    ? { path: href, rest: '' }
    : { path: href.slice(0, cut), rest: href.slice(cut) };
}

/**
 * A link's `href` as an Arabic page writes it: a page with an Arabic twin (a website page,
 * sign-in, sign-up, a library article) points at the twin, keeping its query and hash; anything
 * else (the app, `/recover`, `#anchor`, `mailto:`, another origin) is returned unchanged.
 */
export function localizeHref(href: string): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const { path, rest } = splitHref(href);
  return hasArabicTwin(path) ? `${arabicTwinPath(path)}${rest}` : href;
}

/**
 * Where the language switch goes on `pathname`, or `undefined` to stay (a page without a twin,
 * or already in that language). `?lang=` is dropped — the path now names the language — and the
 * rest of the query and the hash are kept.
 */
export function languageSwitchTarget(
  pathname: string | null | undefined,
  toArabic: boolean,
  search = '',
  hash = '',
): string | undefined {
  if (typeof pathname !== 'string') return undefined;
  const arabicNow = isArabicPublicPath(pathname);
  const english = englishPublicPath(pathname);
  if (!hasArabicTwin(english) || arabicNow === toArabic) return undefined;
  const params = new URLSearchParams(search);
  params.delete('lang');
  const query = params.toString();
  const target = toArabic ? arabicTwinPath(english) : english;
  return `${target}${query === '' ? '' : `?${query}`}${hash}`;
}

/** The `hreflang` alternates of a page with a twin, or `undefined` for a page without one. */
export function publicAlternates(
  pathname: string | null | undefined,
): { readonly en: string; readonly ar: string } | undefined {
  if (typeof pathname !== 'string') return undefined;
  const english = englishPublicPath(pathname);
  return hasArabicTwin(english) ? { en: english, ar: arabicTwinPath(english) } : undefined;
}

/**
 * The Arabic tab title of a public page: the same string the boot script and
 * `WebsiteDocumentTitle` would write over the English one, so neither changes it.
 */
export function arabicPublicTitle(path: PublicLocalizedPath): string {
  if (path === '/') {
    return homePageTitle(ARABIC_ROUTE_LOCALE);
  }
  const entry = ROUTE_TITLES[path];
  if (entry === undefined || entry === PAGE_OWNS_TITLE) {
    throw new Error(`No page name for public route ${path}`);
  }
  const name = translate(ARABIC_ROUTE_LOCALE, entry.key as MessageKey);
  return `${name === entry.key ? entry.en : name}${TITLE_SUFFIX}`;
}

/** The metadata of an Arabic public page: its Arabic title and the Arabic site description. */
export function arabicPublicMetadata(path: PublicLocalizedPath): Metadata {
  return {
    title: { absolute: arabicPublicTitle(path) },
    description:
      path === '/'
        ? translate(ARABIC_ROUTE_LOCALE, 'HomePage.betaHeroLede')
        : siteDescription(ARABIC_ROUTE_LOCALE),
  };
}

/**
 * The metadata of the Arabic twin of a route whose name is in `ROUTE_TITLES` (`/sign-in`,
 * `/sign-up`): its Arabic tab title and the Arabic site description.
 */
export function arabicRouteMetadata(pattern: ArabicAuthPath): Metadata {
  const entry = ROUTE_TITLES[pattern];
  if (entry === undefined || entry === PAGE_OWNS_TITLE) {
    throw new Error(`No page name for route ${pattern}`);
  }
  const name = translate(ARABIC_ROUTE_LOCALE, entry.key as MessageKey);
  return {
    title: { absolute: `${name === entry.key ? entry.en : name}${TITLE_SUFFIX}` },
    description: siteDescription(ARABIC_ROUTE_LOCALE),
    robots: authPageRobots(pattern),
  };
}
