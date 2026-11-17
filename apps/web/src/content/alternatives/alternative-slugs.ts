/**
 * The slugs of the "X alternative" pages (`/alternatives/<slug>`), without their content (SEOF,
 * 2026-11-17). Each is also the slug of that product's compare and switch pages. Browser code that
 * only needs the addresses (the Arabic twin table, the compare and switch pages' links) reads
 * this list, so the entries stay out of every public page's bundle; `alternative-pages.test.tsx`
 * keeps it equal to the slugs of `ALTERNATIVE_ENTRIES`, in the same order.
 */
export const ALTERNATIVE_SLUGS = ['basecamp', 'monday', 'clickup', 'asana', 'trello'] as const;

export type AlternativeSlug = (typeof ALTERNATIVE_SLUGS)[number];

const SLUGS: ReadonlySet<string> = new Set(ALTERNATIVE_SLUGS);

/** True when `slug` has an alternative page. */
export function hasAlternativePage(slug: string): slug is AlternativeSlug {
  return SLUGS.has(slug);
}

/** `/alternatives`, `/alternatives/<slug>`, or their Arabic twins under `/ar`. */
export function alternativeHref(slug: string | undefined, language: 'en' | 'ar'): string {
  const path = slug === undefined ? '/alternatives' : `/alternatives/${slug}`;
  return language === 'ar' ? `/ar${path}` : path;
}
