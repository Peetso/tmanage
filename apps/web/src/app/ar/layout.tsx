import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { WebsiteChrome } from '../../components/website/WebsiteChrome';
import { ARABIC_ROUTE_LOCALE } from '../../lib/i18n/public-locale-routes';
import { RouteLocaleProvider } from '../../lib/i18n/route-locale';

/**
 * The public website in Arabic (`/ar`, `/ar/pricing`, … — NFR-02, audit gap 5).
 *
 * The same pages and chrome as the `(website)` group, rendered with the route locale `ar-EG`, so
 * the prerendered HTML carries Arabic text and an Arabic title (and, after the build,
 * `lang="ar" dir="rtl"` on `<html>`: `scripts/localize-prerendered-html.mjs`). Static like the
 * English pages, so the CDN caches both. Indexed like the English site.
 */
export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

export default function ArabicWebsiteLayout({ children }: { children: ReactNode }) {
  return (
    <RouteLocaleProvider locale={ARABIC_ROUTE_LOCALE}>
      <WebsiteChrome>{children}</WebsiteChrome>
    </RouteLocaleProvider>
  );
}
