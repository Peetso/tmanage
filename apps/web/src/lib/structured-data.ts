import { HELLO_EMAIL, SOCIAL_PROFILES, SUPPORT_EMAIL } from './public-contact';
import { absoluteSiteUrl, siteOrigin } from './site-origin';

/**
 * schema.org JSON-LD for the public website (AGENTREADY, 2026-11-16). Only what the site really
 * says: the company, the site and the product (free during the beta, price 0, no ratings), the
 * pricing page's FAQ and the breadcrumbs an article page shows; since SEOA (2026-11-17) also the
 * compare hub's list, a compare or switch page's WebPage, a help article's steps and a library
 * article. `PublicStructuredData` renders the home and pricing data; the help, library, compare
 * and switch routes render their own on the server (`structured-data/*JsonLd`, SEOE).
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
        email: HELLO_EMAIL,
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

/** The company as a short node, for the `author` and `publisher` of a page. */
function organizationRef(origin: string): JsonLd {
  return {
    '@type': 'Organization',
    '@id': ids(origin).organization,
    name: 'TManage',
    url: absoluteSiteUrl('/', origin),
  };
}

/**
 * A WebPage about named products (a compare or switch page, SEOA 2026-11-17): each product is
 * named in words only, as a SoftwareApplication, and `dateModified` is set only when the page
 * shows the date (a compare page's "Last checked").
 */
export function webPageAbout(input: {
  readonly language: PageLanguage;
  readonly url: string;
  readonly name: string;
  readonly about: readonly string[];
  readonly dateModified?: string;
  readonly origin?: string;
}): JsonLd {
  const origin = input.origin ?? siteOrigin();
  return {
    '@context': CONTEXT,
    '@type': 'WebPage',
    url: input.url,
    name: input.name,
    inLanguage: input.language,
    isPartOf: { '@id': ids(origin).website },
    about: input.about.map((name) => ({ '@type': 'SoftwareApplication', name })),
    ...(input.dateModified === undefined ? {} : { dateModified: input.dateModified }),
  };
}

/** An ItemList of the pages a hub page lists, in the order it shows them. */
export function itemList(input: {
  readonly name: string;
  readonly items: readonly { readonly name: string; readonly url: string }[];
}): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'ItemList',
    name: input.name,
    numberOfItems: input.items.length,
    itemListElement: input.items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      url: item.url,
    })),
  };
}

/** A HowTo of the numbered steps a page shows. */
export function howTo(input: {
  readonly language: PageLanguage;
  readonly url: string;
  readonly name: string;
  readonly steps: readonly string[];
}): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'HowTo',
    url: input.url,
    name: input.name,
    inLanguage: input.language,
    step: input.steps.map((text, index) => ({
      '@type': 'HowToStep',
      position: index + 1,
      text,
    })),
  };
}

/**
 * An Article written by the TManage team. The dates are optional: they are set only once the
 * page shows them.
 */
export function article(input: {
  readonly language: PageLanguage;
  readonly url: string;
  readonly headline: string;
  readonly description: string;
  readonly datePublished?: string;
  readonly dateModified?: string;
  readonly origin?: string;
}): JsonLd {
  const author = organizationRef(input.origin ?? siteOrigin());
  return {
    '@context': CONTEXT,
    '@type': 'Article',
    url: input.url,
    mainEntityOfPage: input.url,
    headline: input.headline,
    description: input.description,
    inLanguage: input.language,
    author,
    publisher: author,
    ...(input.datePublished === undefined ? {} : { datePublished: input.datePublished }),
    ...(input.dateModified === undefined ? {} : { dateModified: input.dateModified }),
  };
}

/**
 * Several JSON-LD items as one `@graph` under one `@context`; a single item is returned as it is,
 * and none gives `undefined`.
 */
export function jsonLdGraph(items: readonly JsonLd[]): JsonLd | undefined {
  if (items.length <= 1) return items[0];
  return {
    '@context': CONTEXT,
    '@graph': items.map((item) =>
      Object.fromEntries(Object.entries(item).filter(([key]) => key !== '@context')),
    ),
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
