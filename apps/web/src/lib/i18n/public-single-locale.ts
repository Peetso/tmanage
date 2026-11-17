import { isArabicPublicPath, publicAlternates } from './public-locale-routes';

/**
 * Pages that exist in one language only (SEO plan 3.6, slice B12). Most public pages have an
 * English page and an Arabic twin (`/pricing` ↔ `/ar/pricing`), and each names the other with
 * `hreflang`. Some searches exist in one language only (an Arabic-only article answering an Arabic
 * question), and their page has no twin: it must not point at an address that does not exist.
 */

/** A language a public page is published in. */
export type PublicLanguage = 'en' | 'ar';

/**
 * The served paths of the pages that have no twin. Empty until the first such page is registered
 * (B0 adds each one with its route), e.g. `'/ar/resources/<slug>'` for an Arabic-only article.
 */
export const SINGLE_LOCALE_PATHS: readonly string[] = [];

/** The `hreflang` alternates of a public page, as paths: only the languages it exists in. */
export interface PublicPageLanguages {
  readonly languages: Readonly<Partial<Record<PublicLanguage, string>>>;
  /** English when it exists, otherwise the one language there is. */
  readonly xDefault: string;
}

/**
 * The languages the public page at `pathname` exists in: both for a page with a twin, its own one
 * for a page in `singleLocalePaths`, `undefined` for anything else (not a public page).
 */
export function publicPageLanguages(
  pathname: string | null | undefined,
  singleLocalePaths: readonly string[] = SINGLE_LOCALE_PATHS,
): PublicPageLanguages | undefined {
  if (typeof pathname !== 'string') return undefined;
  const twins = publicAlternates(pathname);
  if (twins !== undefined) return { languages: twins, xDefault: twins.en };
  if (!singleLocalePaths.includes(pathname)) return undefined;
  const language: PublicLanguage = isArabicPublicPath(pathname) ? 'ar' : 'en';
  return { languages: { [language]: pathname }, xDefault: pathname };
}
