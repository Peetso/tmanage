'use client';

import { usePathname } from 'next/navigation';
import { publicPageLanguages } from '../../lib/i18n/public-single-locale';
import { absoluteSiteUrl } from '../../lib/site-origin';

/**
 * The canonical URL of a public page and its `hreflang` alternates with the Arabic twin
 * (`/pricing` ↔ `/ar/pricing`), English as `x-default`. A page that exists in one language only
 * (B12) names only that language, and is its own `x-default`. React hoists these `<link>` elements
 * into `<head>`, also in the prerendered HTML, so crawlers find each language's URL. Absolute, on
 * the site's own origin (AGENTREADY): each language version is its own canonical page.
 */
export function PublicLocaleAlternates() {
  const pathname = usePathname();
  const page = publicPageLanguages(pathname);
  if (page === undefined) return null;
  return (
    <>
      <link rel="canonical" href={absoluteSiteUrl(pathname)} />
      {page.languages.en !== undefined && (
        <link rel="alternate" hrefLang="en" href={absoluteSiteUrl(page.languages.en)} />
      )}
      {page.languages.ar !== undefined && (
        <link rel="alternate" hrefLang="ar" href={absoluteSiteUrl(page.languages.ar)} />
      )}
      <link rel="alternate" hrefLang="x-default" href={absoluteSiteUrl(page.xDefault)} />
    </>
  );
}
