'use client';

import { lazy, Suspense, type ComponentType } from 'react';
import { usePathname } from 'next/navigation';
import { BETA_FAQ } from './pages/pricing/pricing-data';
import {
  JsonLdScript,
  type PageContext,
  type PageFamilyProps,
} from './structured-data/page-context';
import { siteDescription } from '../../lib/i18n/locale-html';
import {
  ARABIC_ROUTE_LOCALE,
  arabicTwinPath,
  englishPublicPath,
  isArabicPublicPath,
} from '../../lib/i18n/public-locale-routes';
import { translate, type MessageKey } from '../../lib/i18n/t';
import { absoluteSiteUrl } from '../../lib/site-origin';
import { faqPage, homeGraph, type JsonLd } from '../../lib/structured-data';

/*
 * The help, library and compare families each load their own code and data only on their own
 * pages (SEOC, 2026-11-17): this component sits in the chrome of every public page, and importing
 * them here put every help article, compare entry and library card into every page's bundle. The
 * server still renders their JSON-LD into the prerendered HTML; the browser fetches the family's
 * chunk only to hydrate a page of that family.
 */
const HelpJsonLd = lazy(() =>
  import('./structured-data/HelpJsonLd').then((module) => ({ default: module.HelpJsonLd })),
);
const ResourceJsonLd = lazy(() =>
  import('./structured-data/ResourceJsonLd').then((module) => ({ default: module.ResourceJsonLd })),
);
const CompareJsonLd = lazy(() =>
  import('./structured-data/CompareJsonLd').then((module) => ({ default: module.CompareJsonLd })),
);

/** The family whose structured data the page at an English path has, if any. */
function familyOf(english: string): ComponentType<PageFamilyProps> | undefined {
  if (english.startsWith('/help/')) return HelpJsonLd;
  if (english.startsWith('/resources/')) return ResourceJsonLd;
  if (english === '/compare' || english.startsWith('/compare/') || english.startsWith('/switch/')) {
    return CompareJsonLd;
  }
  return undefined;
}

/** The home page's and the pricing page's JSON-LD; empty for any other page. */
function ownData(context: PageContext): JsonLd[] {
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
  return [];
}

/**
 * schema.org JSON-LD for the public page at the current address (AGENTREADY, SEOA): the company,
 * site and product on the home page, the FAQ on pricing, the list on the compare hub, the products
 * and checked date on a compare or switch page, the breadcrumb trail (and steps, or the article)
 * on a help or library article. Only what the page shows. Always in the language of the URL
 * (`/ar/...` is Arabic), never the visitor's saved one, so the prerendered HTML and the hydrated
 * page agree.
 */
export function PublicStructuredData() {
  const pathname = usePathname() ?? '/';
  const arabic = isArabicPublicPath(pathname);
  const locale = arabic ? ARABIC_ROUTE_LOCALE : 'en';
  const context: PageContext = {
    english: englishPublicPath(pathname),
    language: arabic ? 'ar' : 'en',
    t: (key) => translate(locale, key),
    url: (path) => absoluteSiteUrl(arabic ? arabicTwinPath(path) : path),
  };
  const Family = familyOf(context.english);
  if (Family === undefined) return <JsonLdScript items={ownData(context)} />;
  return (
    <Suspense fallback={null}>
      <Family context={context} />
    </Suspense>
  );
}
