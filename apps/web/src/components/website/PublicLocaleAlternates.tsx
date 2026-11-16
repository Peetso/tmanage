'use client';

import { usePathname } from 'next/navigation';
import { publicAlternates } from '../../lib/i18n/public-locale-routes';
import { absoluteSiteUrl } from '../../lib/site-origin';

/**
 * The canonical URL of a public page and its `hreflang` alternates with the Arabic twin
 * (`/pricing` ↔ `/ar/pricing`), English as `x-default`. React hoists these `<link>` elements into
 * `<head>`, also in the prerendered HTML, so crawlers find each language's URL. Absolute, on the
 * site's own origin (AGENTREADY): each language version is its own canonical page.
 */
export function PublicLocaleAlternates() {
  const pathname = usePathname();
  const alternates = publicAlternates(pathname);
  if (alternates === undefined) return null;
  return (
    <>
      <link rel="canonical" href={absoluteSiteUrl(pathname)} />
      <link rel="alternate" hrefLang="en" href={absoluteSiteUrl(alternates.en)} />
      <link rel="alternate" hrefLang="ar" href={absoluteSiteUrl(alternates.ar)} />
      <link rel="alternate" hrefLang="x-default" href={absoluteSiteUrl(alternates.en)} />
    </>
  );
}
