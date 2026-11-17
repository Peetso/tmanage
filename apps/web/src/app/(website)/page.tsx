import type { Metadata } from 'next';
import { HomePage } from '../../components/website/pages/home/HomePage';
import { translate } from '../../lib/i18n/t';

/**
 * WEB-01 Home — the public website's landing page (`/`).
 *
 * A thin route wrapper inside the `(website)` group, so it gets Web/Nav, one `<main>` and
 * Web/Footer from the group layout. `HomePage` (a client component) renders every section of
 * SITE-SPEC "PAGE: Home". Sign-in stays one click away in the nav and the hero.
 */
export const metadata: Metadata = {
  // The hero's own lines (SIGNUP2), so the tab, the search snippet and the page say the same.
  title: { absolute: `TManage — ${translate('en-US', 'HomePage.betaHeroTitle')}` },
  description: translate('en-US', 'HomePage.betaHeroLede'),
};

export default function RootPage() {
  return <HomePage />;
}
