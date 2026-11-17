import type { HelpSlug } from '../help/help-slugs';

/**
 * The slugs of the compare pages (`/compare/<slug>`) and the "switch from X" pages
 * (`/switch/<slug>`), without their content (SEOE, 2026-11-17). Browser code that only needs the
 * addresses (the Arabic twin table in `public-locale-routes.ts`, the help article's links back)
 * reads these, so the full entries stay out of every public page's bundle. `compare-slugs.test.tsx`
 * keeps them equal to the slugs of `COMPARE_ENTRIES` and `SWITCH_ENTRIES`, in the same order.
 */
export const COMPARE_SLUGS = [
  'basecamp',
  'monday',
  'clickup',
  'asana',
  'teamwork',
  'zoho-projects',
  'notion',
  'microsoft-teams',
  'trello',
  'jira',
  'slack',
  'wrike',
  'productive',
  'scoro',
  'accelo',
  'bonsai',
  'plutio',
  'suitedash',
  'moxo',
  'assembly',
] as const;

export type CompareSlug = (typeof COMPARE_SLUGS)[number];

/** A "switch from X" page and the pages about the same product it links to, both ways. */
export interface SwitchLinks {
  readonly slug: string;
  /** The product name, in Latin script in both languages (as on the switch page). */
  readonly name: string;
  /** The "Move your work from X" help article (SEOD, B18). */
  readonly helpSlug: HelpSlug;
  /** The compare page of the same product, when there is one. */
  readonly compareSlug?: CompareSlug;
}

export const SWITCH_LINKS: readonly SwitchLinks[] = [
  { slug: 'monday', name: 'monday.com', helpSlug: 'export-from-monday', compareSlug: 'monday' },
  { slug: 'asana', name: 'Asana', helpSlug: 'export-from-asana', compareSlug: 'asana' },
  { slug: 'clickup', name: 'ClickUp', helpSlug: 'export-from-clickup', compareSlug: 'clickup' },
  { slug: 'trello', name: 'Trello', helpSlug: 'export-from-trello', compareSlug: 'trello' },
  { slug: 'basecamp', name: 'Basecamp', helpSlug: 'export-from-basecamp', compareSlug: 'basecamp' },
  { slug: 'jira', name: 'Jira', helpSlug: 'export-from-jira', compareSlug: 'jira' },
];

export const SWITCH_SLUGS: readonly string[] = SWITCH_LINKS.map((links) => links.slug);

/** The links of the switch page `slug`. */
export function switchLinks(slug: string): SwitchLinks | undefined {
  return SWITCH_LINKS.find((links) => links.slug === slug);
}

/** The switch page whose help article is `helpSlug`, if any. */
export function switchLinksOfHelp(helpSlug: string): SwitchLinks | undefined {
  return SWITCH_LINKS.find((links) => links.helpSlug === helpSlug);
}
