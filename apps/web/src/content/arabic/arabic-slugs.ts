/**
 * Row 57-07 (MENA) — the paths of the Arabic-first product page and its use-case pages, without
 * their content: the Arabic twin table (`public-locale-routes.ts`) runs on every public page, and
 * the words must not come with it. `arabic-pages.test.ts` keeps these equal to the entries.
 */
export const ARABIC_FIRST_PATH = '/arabic';

export const ARABIC_USE_CASE_SLUGS = [
  'client-approvals',
  'monthly-clients',
  'arabic-and-english',
] as const;

export type ArabicUseCaseSlug = (typeof ARABIC_USE_CASE_SLUGS)[number];

/** `/arabic` and every `/arabic/<slug>`, each with an Arabic twin under `/ar`. */
export const ARABIC_KIT_PATHS: readonly string[] = [
  ARABIC_FIRST_PATH,
  ...ARABIC_USE_CASE_SLUGS.map((slug) => `${ARABIC_FIRST_PATH}/${slug}`),
];

/** The English path of the product page or one use case; Arabic pages prefix `/ar`. */
export function arabicKitHref(slug?: ArabicUseCaseSlug, language: 'en' | 'ar' = 'en'): string {
  const path = slug === undefined ? ARABIC_FIRST_PATH : `${ARABIC_FIRST_PATH}/${slug}`;
  return language === 'ar' ? `/ar${path}` : path;
}
