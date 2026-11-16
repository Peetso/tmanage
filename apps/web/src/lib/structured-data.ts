import { SOCIAL_PROFILES, SUPPORT_EMAIL } from './public-contact';
import { absoluteSiteUrl, siteOrigin } from './site-origin';

/**
 * schema.org JSON-LD for the public website (AGENTREADY, 2026-11-16). Only what the site really
 * says: the company, the site and the product (free during the beta, price 0, no ratings), the
 * pricing page's FAQ and the breadcrumbs an article page shows. `PublicStructuredData` renders it.
 */

export type JsonLd = { readonly [key: string]: JsonLdValue };
export type JsonLdValue = string | number | boolean | JsonLd | readonly JsonLdValue[];

/** `en` or `ar`: the language of the page the data describes. */
export type PageLanguage = 'en' | 'ar';

const CONTEXT = 'https://schema.org';

function ids(origin: string): { organization: string; website: string } {
  return { organization: `${origin}/#organization`, website: `${origin}/#website` };
}

/** The home page's graph: Organization, WebSite and SoftwareApplication. */
export function homeGraph(input: {
  readonly language: PageLanguage;
  readonly description: string;
  readonly origin?: string;
}): JsonLd {
  const origin = input.origin ?? siteOrigin();
  const id = ids(origin);
  const home = absoluteSiteUrl(input.language === 'ar' ? '/ar' : '/', origin);
  return {
    '@context': CONTEXT,
    '@graph': [
      {
        '@type': 'Organization',
        '@id': id.organization,
        name: 'TManage',
        url: absoluteSiteUrl('/', origin),
        logo: `${origin}/brand/tmanage-icon-512.png`,
        email: SUPPORT_EMAIL,
        contactPoint: {
          '@type': 'ContactPoint',
          contactType: 'customer support',
          email: SUPPORT_EMAIL,
          url: absoluteSiteUrl('/contact', origin),
          availableLanguage: ['English', 'Arabic'],
        },
        sameAs: [...SOCIAL_PROFILES],
      },
      {
        '@type': 'WebSite',
        '@id': id.website,
        name: 'TManage',
        url: home,
        inLanguage: input.language,
        publisher: { '@id': id.organization },
      },
      {
        '@type': 'SoftwareApplication',
        name: 'TManage',
        url: home,
        description: input.description,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        inLanguage: input.language,
        publisher: { '@id': id.organization },
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          description: 'Free during the beta',
        },
      },
    ],
  };
}

/** A FAQPage of the questions and answers a page shows. */
export function faqPage(input: {
  readonly language: PageLanguage;
  readonly url: string;
  readonly items: readonly { readonly question: string; readonly answer: string }[];
}): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'FAQPage',
    url: input.url,
    inLanguage: input.language,
    mainEntity: input.items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

/** A BreadcrumbList of the trail a page shows, ending with the page itself. */
export function breadcrumbList(
  trail: readonly { readonly name: string; readonly url: string }[],
): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((step, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: step.name,
      item: step.url,
    })),
  };
}

/**
 * JSON for inside a `<script type="application/ld+json">`: `<`, `>`, `&` and the two JavaScript
 * line separators escaped, so no text in the data can close the element or start markup.
 */
export function jsonLdText(data: JsonLd): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
