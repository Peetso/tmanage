/**
 * The day each public page's words last changed (SEO plan T5, slice B10), for `<lastmod>` in
 * `sitemap.xml`. A search engine trusts `<lastmod>` only while it is true: stamping every page
 * with the build day on each deploy teaches it to ignore the date, and IndexNow
 * (`scripts/indexnow-ping.mjs`) would report every page as changed.
 *
 * A date here is the newest of the last commit to the page's own sources (its route, its
 * `components/website/pages/...` folder and the `content/...` files it imports) and the last commit
 * that changed one of its message keys in the English or Arabic catalog, read from git on
 * 2026-11-17. Both language versions share it. **When you change a page's words, set its date to
 * that day.** A page not listed keeps the date its entry already has: the content's own (a compare
 * page's check date) or, when nothing better is known, the build day.
 */
const PAGE_DATES: Readonly<Record<string, string>> = {
  '/': '2026-11-17',
  '/about': '2026-11-09',
  '/accessibility': '2026-11-17',
  '/alternatives': '2026-11-17',
  '/client-portal': '2026-11-09',
  '/contact': '2026-11-17',
  '/customers': '2026-11-09',
  '/developers': '2026-11-09',
  '/download': '2026-11-09',
  '/facts': '2026-11-17',
  '/features/communication': '2026-11-09',
  '/features/insights': '2026-11-09',
  '/features/knowledge': '2026-11-09',
  '/features/work': '2026-11-09',
  '/integrations': '2026-11-10',
  '/pricing': '2026-11-09',
  '/product': '2026-11-17',
  '/resources': '2026-11-17',
  '/security': '2026-11-17',
  '/security/data-location': '2026-11-15',
  '/security/disclosure': '2026-11-17',
  '/solutions/agencies': '2026-11-09',
  '/solutions/consultancies': '2026-11-09',
  '/solutions/in-house': '2026-11-09',
};

/** Every English path with a known last-changed date. */
export const DATED_PUBLIC_PATHS: readonly string[] = Object.keys(PAGE_DATES);

/**
 * The `YYYY-MM-DD` a public page last changed: its known date, else the date its entry already has
 * (the build day only when nothing better is known).
 */
export function pageLastModified(page: {
  readonly path: string;
  readonly lastModified: string;
}): string {
  return PAGE_DATES[page.path] ?? page.lastModified;
}
