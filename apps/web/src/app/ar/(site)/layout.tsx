import type { ReactNode } from 'react';
import { WebsiteChrome } from '../../../components/website/WebsiteChrome';
import { CatalogScope } from '../../../lib/i18n/catalog-scope';

/**
 * The Arabic website pages and articles (`/ar`, `/ar/pricing`, `/ar/resources/<slug>` …): the same
 * Web/Nav, `<main>` and Web/Footer as the English `(website)` group. A route group, so no URL
 * changes; `/ar/sign-in` and `/ar/sign-up` sit outside it, like their English twins.
 */
export default function ArabicWebsiteLayout({ children }: { children: ReactNode }) {
  // CATSPLIT: a website page downloads only its language's `site` catalog part.
  return (
    <CatalogScope scope="site">
      <WebsiteChrome>{children}</WebsiteChrome>
    </CatalogScope>
  );
}
