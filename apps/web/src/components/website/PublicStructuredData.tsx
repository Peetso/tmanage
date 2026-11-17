'use client';

import { usePathname } from 'next/navigation';
import { BETA_FAQ } from './pages/pricing/pricing-data';
import { JsonLdScript, pageContext, type PageContext } from './structured-data/page-context';
import { siteDescription } from '../../lib/i18n/locale-html';
import {
  ARABIC_ROUTE_LOCALE,
  englishPublicPath,
  isArabicPublicPath,
} from '../../lib/i18n/public-locale-routes';
import type { MessageKey } from '../../lib/i18n/t';
import { faqPage, homeGraph, type JsonLd } from '../../lib/structured-data';

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
 * schema.org JSON-LD of the home page (the company, site and product) and of pricing (the FAQ),
 * which are rendered by the catch-all and the website group without a page of their own to carry
 * it (AGENTREADY, SEOA). The help, library, compare and switch pages render theirs on the server
 * from their own route (`structured-data/*JsonLd`, SEOE), so their content stays out of this
 * chrome's bundle and their JSON-LD is in the first HTML. Always in the language of the URL
 * (`/ar/...` is Arabic), never the visitor's saved one, so the prerendered HTML and the hydrated
 * page agree.
 */
export function PublicStructuredData() {
  const pathname = usePathname() ?? '/';
  const context = pageContext(
    englishPublicPath(pathname),
    isArabicPublicPath(pathname) ? 'ar' : 'en',
  );
  return <JsonLdScript items={ownData(context)} />;
}
