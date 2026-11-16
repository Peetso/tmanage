'use client';

import { usePathname } from 'next/navigation';
import { findResource } from './pages/resources/resources-data';
import { BETA_FAQ } from './pages/pricing/pricing-data';
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
  breadcrumbList,
  faqPage,
  homeGraph,
  jsonLdText,
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

function helpTrail(context: PageContext, slug: string): JsonLd | undefined {
  const article = findHelpArticle(slug);
  if (article === undefined) return undefined;
  const copy = helpCopy(context.language);
  const category = findHelpCategory(article.category);
  return breadcrumbList([
    { name: copy.home, url: context.url('/help') },
    { name: category.title[context.language], url: `${context.url('/help')}#topic-${category.id}` },
    { name: article[context.language].title, url: context.url(context.english) },
  ]);
}

function resourceTrail(context: PageContext, slug: string): JsonLd | undefined {
  const item = findResource(slug);
  if (item === undefined) return undefined;
  return breadcrumbList([
    { name: context.t('ResourceArticlePage.resources'), url: context.url('/resources') },
    { name: context.t(item.titleKey), url: context.url(context.english) },
  ]);
}

/** The structured data of a public page, or `undefined` when the page has none. */
function structuredDataFor(context: PageContext): JsonLd | undefined {
  const { english } = context;
  if (english === '/') {
    return homeGraph({
      language: context.language,
      description: siteDescription(context.language === 'ar' ? ARABIC_ROUTE_LOCALE : 'en-US'),
    });
  }
  if (english === '/pricing') {
    return faqPage({
      language: context.language,
      url: context.url(english),
      items: BETA_FAQ.map((item) => ({
        question: context.t(item.questionKey as MessageKey),
        answer: context.t(item.answerKey as MessageKey),
      })),
    });
  }
  if (english.startsWith('/help/')) return helpTrail(context, english.slice('/help/'.length));
  if (english.startsWith('/resources/')) {
    return resourceTrail(context, english.slice('/resources/'.length));
  }
  return undefined;
}

/**
 * schema.org JSON-LD for the public page at the current address (AGENTREADY): the company, site
 * and product on the home page, the FAQ on pricing, the breadcrumb trail on an article. Always in
 * the language of the URL (`/ar/...` is Arabic), never the visitor's saved one, so the
 * prerendered HTML and the hydrated page agree. A data block, not a script: the browser never
 * runs it, and the text is escaped so it cannot close the element.
 */
export function PublicStructuredData() {
  const pathname = usePathname() ?? '/';
  const arabic = isArabicPublicPath(pathname);
  const locale = arabic ? ARABIC_ROUTE_LOCALE : 'en';
  const data = structuredDataFor({
    english: englishPublicPath(pathname),
    language: arabic ? 'ar' : 'en',
    t: (key) => translate(locale, key),
    url: (path) => absoluteSiteUrl(arabic ? arabicTwinPath(path) : path),
  });
  if (data === undefined) return null;
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />
  );
}
