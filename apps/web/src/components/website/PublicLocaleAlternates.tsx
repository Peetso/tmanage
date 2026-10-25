'use client';

import { usePathname } from 'next/navigation';
import { publicAlternates } from '../../lib/i18n/public-locale-routes';

/**
 * The `hreflang` alternates of a public page and its Arabic twin (`/pricing` ↔ `/ar/pricing`),
 * with English as `x-default`. React hoists these `<link>` elements into `<head>`, also in the
 * prerendered HTML, so crawlers find each language's URL. The site has no configured public
 * origin, so the URLs are root-relative.
 */
export function PublicLocaleAlternates() {
  const alternates = publicAlternates(usePathname());
  if (alternates === undefined) return null;
  return (
    <>
      <link rel="alternate" hrefLang="en" href={alternates.en} />
      <link rel="alternate" hrefLang="ar" href={alternates.ar} />
      <link rel="alternate" hrefLang="x-default" href={alternates.en} />
    </>
  );
}
