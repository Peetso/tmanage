import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ARABIC_ROUTE_LOCALE } from '../../lib/i18n/public-locale-routes';
import { RouteLocaleProvider } from '../../lib/i18n/route-locale';

/**
 * Everything in Arabic at its own URL (`/ar`, `/ar/pricing`, `/ar/sign-in`, … — NFR-02, audit
 * gap 5).
 *
 * Renders its pages with the route locale `ar-EG`, so the prerendered HTML carries Arabic text and
 * an Arabic title (and, after the build, `lang="ar" dir="rtl"` on `<html>`:
 * `scripts/localize-prerendered-html.mjs`). The website pages get the website chrome from
 * `(site)/layout.tsx`; sign-in and sign-up keep their own identity shell, as in English. Static
 * like the English pages, so the CDN caches both. Indexed like the English site.
 */
export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

export default function ArabicLayout({ children }: { children: ReactNode }) {
  return <RouteLocaleProvider locale={ARABIC_ROUTE_LOCALE}>{children}</RouteLocaleProvider>;
}
