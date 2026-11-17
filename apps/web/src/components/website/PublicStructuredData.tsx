'use client';

import { usePathname } from 'next/navigation';
import { findResource } from './pages/resources/resources-data';
import { BETA_FAQ } from './pages/pricing/pricing-data';
import { COMPARE_COPY, SWITCH_COPY } from '../../content/compare/compare-copy';
import { COMPARE_ENTRIES, findCompareEntry } from '../../content/compare/compare-entries';
import { findSwitchEntry } from '../../content/compare/switch-entries';
import { findHelpArticle, findHelpCategory } from '../../content/help/help-articles';
import { helpCopy } from '../../content/help/help-copy';
import { siteDescription } from '../../lib/i18n/locale-html';
import {
  ARABIC_ROUTE_LOCALE,
  arabicTwinPath,
  englishPublicPath,
  isArabicPublicPath,
} from '../../lib/i18n/public-locale-routes';
import { translate, type MessageKey } from '../../lib/i18n/t';
import { absoluteSiteUrl } from '../../lib/site-origin';
import {
  article,
  breadcrumbList,
  faqPage,
  homeGraph,
  howTo,
  itemList,
  jsonLdGraph,
  jsonLdText,
  webPageAbout,
  type JsonLd,
  type PageLanguage,
} from '../../lib/structured-data';

interface PageContext {
  readonly english: string;
  readonly language: PageLanguage;
  readonly t: (key: MessageKey) => string;
  /** The page's address in its own language, absolute. */
  readonly url: (englishPath: string) => string;
}

function helpData(context: PageContext, slug: string): JsonLd[] {
  const found = findHelpArticle(slug);
  if (found === undefined) return [];
  const copy = helpCopy(context.language);
  const category = findHelpCategory(found.category);
  const text = found[context.language];
  const url = context.url(context.english);
  const steps = text.body.flatMap((block) => (block.kind === 'steps' ? block.items : []));
  return [
    breadcrumbList([
      { name: copy.home, url: context.url('/help') },
      {
        name: category.title[context.language],
        url: `${context.url('/help')}#topic-${category.id}`,
      },
      { name: text.title, url },
    ]),
    ...(steps.length === 0
      ? []
      : [howTo({ language: context.language, url, name: text.title, steps })]),
  ];
}

function resourceData(context: PageContext, slug: string): JsonLd[] {
  const item = findResource(slug);
  if (item === undefined) return [];
  const url = context.url(context.english);
  const headline = context.t(item.titleKey);
  return [
    breadcrumbList([
      { name: context.t('ResourceArticlePage.resources'), url: context.url('/resources') },
      { name: headline, url },
    ]),
    article({
      language: context.language,
      url,
      headline,
      description: context.t(item.lineKey),
    }),
  ];
}

/** The compare hub: the list of compare pages its cards show. */
function compareIndexData(context: PageContext): JsonLd[] {
  const copy = COMPARE_COPY[context.language];
  return [
    itemList({
      name: copy.indexTitle,
      items: COMPARE_ENTRIES.map((entry) => ({
        name: copy.title(entry.name),
        url: context.url(`/compare/${entry.slug}`),
      })),
    }),
  ];
}

/** A compare page: its trail back to the hub and the two products, with the checked date. */
function compareData(context: PageContext, slug: string): JsonLd[] {
  const entry = findCompareEntry(slug);
  if (entry === undefined) return [];
  const copy = COMPARE_COPY[context.language];
  const url = context.url(context.english);
  const name = copy.title(entry.name);
  return [
    breadcrumbList([
      { name: copy.allCompare, url: context.url('/compare') },
      { name, url },
    ]),
    webPageAbout({
      language: context.language,
      url,
      name,
      about: ['TManage', entry.name],
      dateModified: entry.checkedOn,
    }),
  ];
}

/** A switch page: the two products and the "How the move works" text it shows. */
function switchData(context: PageContext, slug: string): JsonLd[] {
  const entry = findSwitchEntry(slug);
  if (entry === undefined) return [];
  const words = SWITCH_COPY[context.language];
  const url = context.url(context.english);
  return [
    webPageAbout({
      language: context.language,
      url,
      name: words.title(entry.name),
      about: ['TManage', entry.name],
    }),
    howTo({
      language: context.language,
      url,
      name: words.howTitle,
      steps: [entry.how[context.language]],
    }),
  ];
}

/** Pages under a prefix and the structured data of the one named by the rest of the path. */
const BY_PREFIX: readonly [string, (context: PageContext, slug: string) => JsonLd[]][] = [
  ['/help/', helpData],
  ['/resources/', resourceData],
  ['/compare/', compareData],
  ['/switch/', switchData],
];

/** Every JSON-LD item of a public page; empty when the page has none. */
function structuredDataFor(context: PageContext): JsonLd[] {
  const { english } = context;
  if (english === '/') {
    return [
      homeGraph({
        language: context.language,
        description: siteDescription(context.language === 'ar' ? ARABIC_ROUTE_LOCALE : 'en-US'),
      }),
    ];
  }
  if (english === '/pricing') {
    return [
      faqPage({
        language: context.language,
        url: context.url(english),
        items: BETA_FAQ.map((item) => ({
          question: context.t(item.questionKey as MessageKey),
          answer: context.t(item.answerKey as MessageKey),
        })),
      }),
    ];
  }
  if (english === '/compare') return compareIndexData(context);
  const match = BY_PREFIX.find(([prefix]) => english.startsWith(prefix));
  return match === undefined ? [] : match[1](context, english.slice(match[0].length));
}

/**
 * schema.org JSON-LD for the public page at the current address (AGENTREADY, SEOA): the company,
 * site and product on the home page, the FAQ on pricing, the list on the compare hub, the products
 * and checked date on a compare or switch page, the breadcrumb trail (and steps, or the article)
 * on a help or library article. Only what the page shows. Always in the language of the URL
 * (`/ar/...` is Arabic), never the visitor's saved one, so the prerendered HTML and the hydrated
 * page agree. A data block, not a script: the browser never runs it, and the text is escaped so it
 * cannot close the element.
 */
export function PublicStructuredData() {
  const pathname = usePathname() ?? '/';
  const arabic = isArabicPublicPath(pathname);
  const locale = arabic ? ARABIC_ROUTE_LOCALE : 'en';
  const data = jsonLdGraph(
    structuredDataFor({
      english: englishPublicPath(pathname),
      language: arabic ? 'ar' : 'en',
      t: (key) => translate(locale, key),
      url: (path) => absoluteSiteUrl(arabic ? arabicTwinPath(path) : path),
    }),
  );
  if (data === undefined) return null;
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />
  );
}
