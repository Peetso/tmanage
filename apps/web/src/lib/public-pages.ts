import { ALL_RESOURCES } from '../components/website/pages/resources/resources-data';
import { ALTERNATIVE_COPY } from '../content/alternatives/alternative-copy';
import {
  ALTERNATIVE_PAGES,
  ALTERNATIVES_UPDATED_ON,
} from '../content/alternatives/alternative-entries';
import { COMPARE_COPY, SWITCH_COPY } from '../content/compare/compare-copy';
import { COMPARE_ENTRIES } from '../content/compare/compare-entries';
import { SWITCH_ENTRIES } from '../content/compare/switch-entries';
import { FACTS_COPY, FACTS_UPDATED_ON } from '../content/facts/facts';
import { HELP_ARTICLES } from '../content/help/help-articles';
import { ARABIC_AUTH_PATHS, PUBLIC_LOCALIZED_PATHS } from './i18n/public-locale-routes';
import { translate } from './i18n/t';
import { PAGE_OWNS_TITLE, ROUTE_TITLES } from './route-titles';

/**
 * The public site as one list (AGENTREADY, 2026-11-16): every English page the sitemap names,
 * with the name, one-line summary and section `llms.txt` groups it under, and the date it last
 * changed. `sitemap.xml`, `llms.txt` and the Markdown pages are all built from this list, so none
 * of them can name a page the others do not.
 *
 * The date is the content's own where it has one (a compare page: the day its facts were
 * checked) and the build's otherwise: the pages are prerendered, so a build is when they change.
 */

export type PublicPageSection =
  | 'product'
  | 'solutions'
  | 'pricing'
  | 'compare'
  | 'help'
  | 'resources'
  | 'trust'
  | 'developers'
  | 'company'
  | 'account';

export interface PublicPage {
  /** The English path; its Arabic twin is `arabicTwinPath(path)`. */
  readonly path: string;
  readonly title: string;
  readonly summary?: string;
  readonly section: PublicPageSection;
  /** ISO date, `YYYY-MM-DD`. */
  readonly lastModified: string;
}

/** The day this build was made: the prerendered pages change only with a build. */
export const SITE_BUILD_DATE = new Date().toISOString().slice(0, 10);

/** The heading each section gets in `llms.txt`, in the order the file lists them. */
export const PUBLIC_PAGE_SECTIONS: readonly { id: PublicPageSection; heading: string }[] = [
  { id: 'product', heading: 'Product' },
  { id: 'solutions', heading: 'Solutions' },
  { id: 'pricing', heading: 'Pricing' },
  { id: 'compare', heading: 'Compare' },
  { id: 'account', heading: 'Get started' },
  { id: 'help', heading: 'Help centre' },
  { id: 'resources', heading: 'Resources' },
  { id: 'developers', heading: 'Developers and the MCP connector' },
  { id: 'trust', heading: 'Security, privacy and accessibility' },
  { id: 'company', heading: 'Company' },
];

const SECTION_BY_PREFIX: readonly [string, PublicPageSection][] = [
  ['/features/', 'product'],
  ['/product', 'product'],
  ['/client-portal', 'product'],
  ['/integrations', 'product'],
  ['/download', 'product'],
  ['/solutions/', 'solutions'],
  ['/pricing', 'pricing'],
  ['/faq', 'pricing'],
  ['/developers', 'developers'],
  ['/security', 'trust'],
  ['/legal/', 'trust'],
  ['/accessibility', 'trust'],
  ['/status', 'trust'],
  ['/sign-', 'account'],
];

function sectionOf(path: string): PublicPageSection {
  return SECTION_BY_PREFIX.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'company';
}

function routeName(path: string): string {
  const entry = ROUTE_TITLES[path];
  if (entry === undefined || entry === PAGE_OWNS_TITLE) {
    throw new Error(`No page name for public route ${path}`);
  }
  return entry.en;
}

function websitePage(path: string): PublicPage {
  if (path === '/') {
    return {
      path,
      title: 'TManage',
      summary: translate('en', 'HomePage.betaHeroLede'),
      section: 'product',
      lastModified: SITE_BUILD_DATE,
    };
  }
  return { path, title: routeName(path), section: sectionOf(path), lastModified: SITE_BUILD_DATE };
}

function resourcePages(): PublicPage[] {
  return ALL_RESOURCES.map((item) => ({
    path: `/resources/${item.slug}`,
    title: item.title,
    summary: item.line,
    section: 'resources',
    lastModified: SITE_BUILD_DATE,
  }));
}

function helpPages(): PublicPage[] {
  return [
    { path: '/help', title: routeName('/help'), section: 'help', lastModified: SITE_BUILD_DATE },
    ...HELP_ARTICLES.map((article): PublicPage => ({
      path: `/help/${article.slug}`,
      title: article.en.title,
      summary: article.en.summary,
      section: 'help',
      lastModified: SITE_BUILD_DATE,
    })),
  ];
}

function comparePages(): PublicPage[] {
  const newest =
    COMPARE_ENTRIES.map((entry) => entry.checkedOn)
      .sort()
      .at(-1) ?? SITE_BUILD_DATE;
  return [
    {
      path: '/compare',
      title: COMPARE_COPY.en.indexTitle,
      section: 'compare',
      lastModified: newest,
    },
    ...COMPARE_ENTRIES.map((entry): PublicPage => ({
      path: `/compare/${entry.slug}`,
      title: COMPARE_COPY.en.title(entry.name),
      summary: entry.strong.en,
      section: 'compare',
      lastModified: entry.checkedOn,
    })),
  ];
}

/** Row 54-29 — the "switch from X" pages, listed with the comparisons. */
function switchPages(): PublicPage[] {
  return SWITCH_ENTRIES.map((entry): PublicPage => ({
    path: `/switch/${entry.slug}`,
    title: SWITCH_COPY.en.title(entry.name),
    summary: SWITCH_COPY.en.description(entry.name),
    section: 'compare',
    lastModified: SITE_BUILD_DATE,
  }));
}

/** SEOF (B1) — the "X alternative" pages and their index, listed with the comparisons. */
function alternativePages(): PublicPage[] {
  const copy = ALTERNATIVE_COPY.en;
  return [
    {
      path: '/alternatives',
      title: copy.indexTitle,
      summary: copy.indexDescription,
      section: 'compare',
      lastModified: ALTERNATIVES_UPDATED_ON,
    },
    ...ALTERNATIVE_PAGES.map(({ entry, rival }): PublicPage => ({
      path: `/alternatives/${entry.slug}`,
      title: copy.tabTitle(rival.name),
      summary: copy.description(rival.name),
      section: 'compare',
      lastModified: ALTERNATIVES_UPDATED_ON,
    })),
  ];
}

/** SEOF (B7) — the facts page, first among the product pages. */
const FACTS_PAGE: PublicPage = {
  path: '/facts',
  title: FACTS_COPY.en.title,
  summary: FACTS_COPY.en.description,
  section: 'product',
  lastModified: FACTS_UPDATED_ON,
};

/** Every English public page, in the sitemap's order. */
export const PUBLIC_PAGES: readonly PublicPage[] = [
  ...PUBLIC_LOCALIZED_PATHS.map(websitePage),
  FACTS_PAGE,
  ...resourcePages(),
  ...helpPages(),
  ...comparePages(),
  ...switchPages(),
  ...alternativePages(),
  ...ARABIC_AUTH_PATHS.map(websitePage),
];

const BY_PATH: ReadonlyMap<string, PublicPage> = new Map(
  PUBLIC_PAGES.map((page) => [page.path, page]),
);

/** The public page at an English path, or `undefined` for any other path. */
export function publicPageAt(path: string): PublicPage | undefined {
  return BY_PATH.get(path);
}
