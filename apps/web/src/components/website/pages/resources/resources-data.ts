import type { WebIconName } from '../../WebIcon';

/** WEB-15 Resources — the library's content. Every word is from SITE-SPEC.md or written to it. */

export type ResourceCategory = 'guide' | 'blog' | 'template' | 'update';

export const CATEGORY_LABEL: Record<ResourceCategory, string> = {
  guide: 'Guide',
  blog: 'Blog',
  template: 'Template',
  update: 'Product update',
};

export const CATEGORY_ICON: Record<ResourceCategory, WebIconName> = {
  guide: 'book',
  blog: 'pencil',
  template: 'layers',
  update: 'bolt',
};

export interface ResourceTab {
  id: 'all' | ResourceCategory;
  label: string;
}

export const RESOURCE_TABS: readonly ResourceTab[] = [
  { id: 'all', label: 'All' },
  { id: 'guide', label: 'Guides' },
  { id: 'blog', label: 'Blog' },
  { id: 'template', label: 'Templates' },
  { id: 'update', label: 'Product updates' },
];

export interface Resource {
  slug: string;
  category: ResourceCategory;
  title: string;
  line: string;
  meta: string;
  /** What the reader leaves with — shown on the article page, three short lines. */
  points: readonly [string, string, string];
}

export const FEATURED_GUIDE: Resource = {
  slug: 'client-approval-playbook',
  category: 'guide',
  title: 'The client approval playbook',
  line: 'How to ask for one decision on one exact version — and get it back without a chase.',
  meta: '12 min read',
  points: [
    'Share one version, never a folder',
    'Ask for a decision, not feedback',
    'Keep the answer on the record',
  ],
};

export const FEATURED_SIDE: readonly Resource[] = [
  {
    slug: 'three-dates-three-meanings',
    category: 'blog',
    title: 'Desired, committed, forecast: three dates, three meanings',
    line: 'Why a client’s wish, a team’s promise and the plan’s honest estimate deserve separate fields.',
    meta: '6 min read',
    points: [
      'The desired date is the client’s wish',
      'The committed date is the team’s promise',
      'The forecast date is the plan’s honest estimate',
    ],
  },
  {
    slug: 'website-relaunch-template',
    category: 'template',
    title: 'Website relaunch template',
    line: 'Milestones, requests and approval steps for a relaunch, ready to copy into a project.',
    meta: '8 milestones · 46 work items',
    points: [
      'Eight milestones from brief to launch',
      'Client requests and approvals already in place',
      'Copy it into a project in one step',
    ],
  },
];

export const ARTICLES: readonly Resource[] = [
  {
    slug: 'client-review-in-ten-minutes',
    category: 'guide',
    title: 'How to run a client review in ten minutes',
    line: 'Share one version, ask one question, and leave with a decision on the record.',
    meta: '7 min read',
    points: [
      'Open the exact version, not a folder',
      'Ask the one question you need answered',
      'Record the decision before you hang up',
    ],
  },
  {
    slug: 'requests-your-team-can-commit-to',
    category: 'guide',
    title: 'Writing requests your team can commit to',
    line: 'The four details that turn a vague ask into owned, dated work.',
    meta: '6 min read',
    points: ['Say what done looks like', 'Name one owner', 'Agree a date the team can keep'],
  },
  {
    slug: 'offboarding-a-contractor-safely',
    category: 'guide',
    title: 'Offboarding a contractor safely',
    line: 'Hand over their work, close their access and keep the history intact.',
    meta: '5 min read',
    points: [
      'Reassign their open work first',
      'Close their access in one step',
      'Keep every comment and version on the record',
    ],
  },
  {
    slug: 'no-individual-productivity-scores',
    category: 'blog',
    title: 'Why we don’t score individual productivity',
    line: 'Health you can explain comes from the work, not from watching people.',
    meta: '4 min read',
    points: [
      'Health is read from the work',
      'Nobody is ranked or watched',
      'Every signal can be explained',
    ],
  },
  {
    slug: 'portal-clients-actually-open',
    category: 'blog',
    title: 'Designing a portal clients actually open',
    line: 'What a client needs to understand in thirty seconds — and what to leave out.',
    meta: '8 min read',
    points: [
      'Show what needs the client today',
      'Hide internal noise by default',
      'Make the next decision one tap away',
    ],
  },
  {
    slug: 'arabic-first-product-language',
    category: 'update',
    title: 'Arabic-first product language, explained',
    line: 'Right-to-left layouts, Arabic labels and dates that read naturally in both languages.',
    meta: '5 min read',
    points: [
      'Layouts mirror right to left',
      'Labels written in Arabic, not translated word for word',
      'Dates read naturally in both languages',
    ],
  },
  {
    slug: 'meeting-notes-to-owned-actions',
    category: 'template',
    title: 'From meeting notes to owned actions',
    line: 'An agenda and notes template where every action leaves with an owner and a date.',
    meta: 'Template · 3 min setup',
    points: [
      'An agenda that fits on one screen',
      'Notes that turn into work items',
      'Every action leaves with an owner and a date',
    ],
  },
  {
    slug: 'retainers-without-the-chaos',
    category: 'template',
    title: 'Retainers without the chaos',
    line: 'A monthly retainer project with intake, capacity and a review rhythm built in.',
    meta: 'Template · 5 min setup',
    points: [
      'Intake that turns asks into requests',
      'Capacity you can see each month',
      'A review rhythm the client can follow',
    ],
  },
  {
    slug: 'what-a-governed-version-is',
    category: 'update',
    title: 'What a governed version is — and why it matters',
    line: 'Approvals point at one exact version, so nobody asks which file is final.',
    meta: '4 min read',
    points: [
      'An approval points at one exact version',
      'Later edits make a new version',
      'Nobody asks which file is final',
    ],
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
