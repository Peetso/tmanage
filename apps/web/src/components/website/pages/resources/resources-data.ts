import type { MessageKey } from '../../../../lib/i18n/t';
import type { IconOrbTone } from '../../primitives';
import type { WebIconName } from '../../WebIcon';

/**
 * WEB-15 Resources — the library's content (round-2 Figma frame 308:40). The English fields feed
 * the article page and its metadata; the `*Key` fields are what the index shows, in either
 * language, through the i18n catalog.
 */

export type ResourceCategory = 'guide' | 'blog' | 'template' | 'update';

export const CATEGORY_LABEL: Record<ResourceCategory, string> = {
  guide: 'Guide',
  blog: 'Blog',
  template: 'Template',
  update: 'Product update',
};

/** The upper-case category badge on the index cards. */
export const CATEGORY_BADGE_KEY: Record<ResourceCategory, MessageKey> = {
  guide: 'ResourcesPage.badgeGuide',
  blog: 'ResourcesPage.badgeBlog',
  template: 'ResourcesPage.badgeTemplate',
  update: 'ResourcesPage.badgeUpdate',
};

export const CATEGORY_ICON: Record<ResourceCategory, WebIconName> = {
  guide: 'book',
  blog: 'pencil',
  template: 'layers',
  update: 'bolt',
};

export interface ResourceTab {
  id: 'all' | ResourceCategory;
  labelKey: MessageKey;
}

export const RESOURCE_TABS: readonly ResourceTab[] = [
  { id: 'all', labelKey: 'ResourcesPage.tabAll' },
  { id: 'guide', labelKey: 'ResourcesPage.tabGuides' },
  { id: 'blog', labelKey: 'ResourcesPage.tabBlog' },
  { id: 'template', labelKey: 'ResourcesPage.tabTemplates' },
  { id: 'update', labelKey: 'ResourcesPage.tabUpdates' },
];

export interface Resource {
  slug: string;
  category: ResourceCategory;
  title: string;
  line: string;
  meta: string;
  /** What the reader leaves with — shown on the article page, three short lines. */
  points: readonly [string, string, string];
  titleKey: MessageKey;
  /**
   * A shorter tab title, for an article whose heading would make a tab title over 60 characters
   * (SEOFIX); the heading itself stays the page's H1.
   */
  tabTitle?: string;
  tabTitleKey?: MessageKey;
  lineKey: MessageKey;
  metaKey: MessageKey;
  /** The thumbnail orb on the index card. */
  icon: WebIconName;
  orb: Extract<IconOrbTone, 'outline' | 'ink' | 'lime'>;
}

export const FEATURED_GUIDE: Resource = {
  slug: 'client-approval-playbook',
  category: 'guide',
  title: 'The client approval playbook',
  line: 'How to ask for a decision, bind it to the exact version reviewed and keep the record when the file changes.',
  meta: '12 min read',
  points: [
    'Share one version, never a folder',
    'Ask for a decision, not feedback',
    'Keep the answer on the record',
  ],
  titleKey: 'ResourcesPage.featuredGuideTitle',
  lineKey: 'ResourcesPage.featuredGuideLine',
  metaKey: 'ResourcesPage.featuredGuideMeta',
  icon: 'book',
  orb: 'lime',
};

export const FEATURED_SIDE: readonly Resource[] = [
  {
    slug: 'three-dates-three-meanings',
    category: 'blog',
    title: 'Desired, committed, forecast: three dates, three meanings',
    line: 'Why a wish is never mistaken for a promise, and how each date is set.',
    meta: '6 min read',
    points: [
      'The desired date is the client’s wish',
      'The committed date is the team’s promise',
      'The forecast date is the plan’s honest estimate',
    ],
    titleKey: 'ResourcesPage.sideDatesTitle',
    tabTitle: 'Desired, committed and forecast dates explained',
    tabTitleKey: 'ResourcesPage.sideDatesTabTitle',
    lineKey: 'ResourcesPage.sideDatesLine',
    metaKey: 'ResourcesPage.sideDatesMeta',
    icon: 'calendar',
    orb: 'outline',
  },
  {
    slug: 'website-relaunch-template',
    category: 'template',
    title: 'Website relaunch template',
    line: 'Milestones, review gates and client approvals, ready to copy into a project.',
    meta: 'Template · 14 items',
    points: [
      'Milestones from brief to launch',
      'Client review gates and approvals already in place',
      'Copy it into a project in one step',
    ],
    titleKey: 'ResourcesPage.sideTemplateTitle',
    lineKey: 'ResourcesPage.sideTemplateLine',
    metaKey: 'ResourcesPage.sideTemplateMeta',
    icon: 'layers',
    orb: 'outline',
  },
];

export const ARTICLES: readonly Resource[] = [
  {
    slug: 'client-review-in-ten-minutes',
    category: 'guide',
    title: 'How to run a client review in ten minutes',
    line: 'One version on screen, a short agenda and a decision before anyone leaves.',
    meta: '6 min read',
    points: [
      'Open the exact version, not a folder',
      'Ask the one question you need answered',
      'Record the decision before you hang up',
    ],
    titleKey: 'ResourcesPage.a1Title',
    lineKey: 'ResourcesPage.a1Line',
    metaKey: 'ResourcesPage.a1Meta',
    icon: 'calendar',
    orb: 'outline',
  },
  {
    slug: 'requests-your-team-can-commit-to',
    category: 'guide',
    title: 'Writing requests your team can commit to',
    line: 'What a clear ask contains, and why the desired date is only a wish.',
    meta: '5 min read',
    points: ['Say what done looks like', 'Name one owner', 'Agree a date the team can keep'],
    titleKey: 'ResourcesPage.a2Title',
    lineKey: 'ResourcesPage.a2Line',
    metaKey: 'ResourcesPage.a2Meta',
    icon: 'pencil',
    orb: 'outline',
  },
  {
    slug: 'offboarding-a-contractor-safely',
    category: 'guide',
    title: 'Offboarding a contractor safely',
    line: 'Remove access, hand over ownership and keep the audit trail intact.',
    meta: '7 min read',
    points: [
      'Reassign their open work first',
      'Close their access in one step',
      'Keep every comment and version on the record',
    ],
    titleKey: 'ResourcesPage.a3Title',
    lineKey: 'ResourcesPage.a3Line',
    metaKey: 'ResourcesPage.a3Meta',
    icon: 'shield',
    orb: 'ink',
  },
  {
    slug: 'no-individual-productivity-scores',
    category: 'blog',
    title: 'Why we don’t score individual productivity',
    line: 'We measure delivery health, not people. Here is our reasoning.',
    meta: '4 min read',
    points: [
      'Health is read from the work',
      'Nobody is ranked or watched',
      'Every signal can be explained',
    ],
    titleKey: 'ResourcesPage.a4Title',
    lineKey: 'ResourcesPage.a4Line',
    metaKey: 'ResourcesPage.a4Meta',
    icon: 'chart',
    orb: 'lime',
  },
  {
    slug: 'portal-clients-actually-open',
    category: 'blog',
    title: 'Designing a portal clients actually open',
    line: 'Action first, plain language, and nothing internal by accident.',
    meta: '6 min read',
    points: [
      'Show what needs the client today',
      'Hide internal noise by default',
      'Make the next decision one tap away',
    ],
    titleKey: 'ResourcesPage.a5Title',
    lineKey: 'ResourcesPage.a5Line',
    metaKey: 'ResourcesPage.a5Meta',
    icon: 'portal',
    orb: 'outline',
  },
  {
    slug: 'arabic-first-product-language',
    category: 'update',
    title: 'Arabic-first product language, explained',
    line: 'Why our Arabic is written as product language, not translated copy.',
    meta: '5 min read',
    points: [
      'Layouts mirror right to left',
      'Labels written in Arabic, not translated word for word',
      'Dates read naturally in both languages',
    ],
    titleKey: 'ResourcesPage.a6Title',
    lineKey: 'ResourcesPage.a6Line',
    metaKey: 'ResourcesPage.a6Meta',
    icon: 'chat',
    orb: 'outline',
  },
  {
    slug: 'meeting-notes-to-owned-actions',
    category: 'template',
    title: 'From meeting notes to owned actions',
    line: 'A meeting template where every action lands with an owner and a date.',
    meta: '3 min read',
    points: [
      'An agenda that fits on one screen',
      'Notes that turn into work items',
      'Every action leaves with an owner and a date',
    ],
    titleKey: 'ResourcesPage.a7Title',
    lineKey: 'ResourcesPage.a7Line',
    metaKey: 'ResourcesPage.a7Meta',
    icon: 'list',
    orb: 'ink',
  },
  {
    slug: 'retainers-without-the-chaos',
    category: 'guide',
    title: 'Retainers without the chaos',
    line: 'Scope, capacity and monthly reporting for ongoing client work.',
    meta: '8 min read',
    points: [
      'Intake that turns asks into requests',
      'Capacity you can see each month',
      'A review rhythm the client can follow',
    ],
    titleKey: 'ResourcesPage.a8Title',
    lineKey: 'ResourcesPage.a8Line',
    metaKey: 'ResourcesPage.a8Meta',
    icon: 'briefcase',
    orb: 'outline',
  },
  {
    slug: 'what-a-governed-version-is',
    category: 'update',
    title: 'What a governed version is — and why it matters',
    line: 'One approval, bound to one exact file. Change the file and it resets.',
    meta: '4 min read',
    points: [
      'An approval points at one exact version',
      'Later edits make a new version',
      'Nobody asks which file is final',
    ],
    titleKey: 'ResourcesPage.a9Title',
    lineKey: 'ResourcesPage.a9Line',
    metaKey: 'ResourcesPage.a9Meta',
    icon: 'layers',
    orb: 'lime',
  },
];

/** Every article the index links to, featured ones first. */
export const ALL_RESOURCES: readonly Resource[] = [FEATURED_GUIDE, ...FEATURED_SIDE, ...ARTICLES];

export function findResource(slug: string): Resource | undefined {
  return ALL_RESOURCES.find((item) => item.slug === slug);
}

export function resourceHref(item: Resource): string {
  return `/resources/${item.slug}`;
}

/**
 * The library cards a tab and a search leave on screen. `textOf` returns the card's visible
 * strings in the active language, so the search matches what the reader sees.
 */
export function filterResources(
  items: readonly Resource[],
  tab: ResourceTab['id'],
  query: string,
  textOf: (item: Resource) => readonly string[],
): Resource[] {
  const q = query.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (tab === 'all' || item.category === tab) &&
      (q === '' ||
        [item.title, item.line, ...textOf(item)].some((text) =>
          text.toLocaleLowerCase().includes(q),
        )),
  );
}
