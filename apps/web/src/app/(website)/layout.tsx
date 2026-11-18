import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { WebsiteChrome } from '../../components/website/WebsiteChrome';
import { CatalogScope } from '../../lib/i18n/catalog-scope';

/**
 * The public website (`/`, `/product`, `/features/*`, `/solutions/*`, `/pricing`, `/security`,
 * `/resources`, `/contact`, `/status`, `/changelog`, `/faq`, `/legal/*` …).
 *
 * A route group, so no URL changes: every page here gets Web/Nav, one `<main>` and Web/Footer
 * from `WebsiteChrome`. The root layout keeps tenant screens out of search engines; the public
 * site opts back in here, as the root layout's note anticipated.
 */
export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

export default function WebsiteLayout({ children }: { children: ReactNode }) {
  // CATSPLIT: a website page downloads only its language's `site` catalog part.
  return (
    <CatalogScope scope="site">
      <WebsiteChrome>{children}</WebsiteChrome>
    </CatalogScope>
  );
}
