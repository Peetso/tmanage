import type { Metadata } from 'next';
import { HomePage } from '../../components/website/pages/home/HomePage';
import { translate } from '../../lib/i18n/t';
import { homePageTitle } from '../../lib/route-titles';

/**
 * WEB-01 Home — the public website's landing page (`/`).
 *
 * A thin route wrapper inside the `(website)` group, so it gets Web/Nav, one `<main>` and
 * Web/Footer from the group layout. `HomePage` (a client component) renders every section of
 * SITE-SPEC "PAGE: Home". Sign-in stays one click away in the nav and the hero.
 */
export const metadata: Metadata = {
  // A short tab title (at most 60 characters, SEOFIX); the hero line stays the page's H1 and the
  // lede its search snippet (SIGNUP2).
  title: { absolute: homePageTitle('en-US') },
  description: translate('en-US', 'HomePage.betaHeroLede'),
};

export default function RootPage() {
  return <HomePage />;
}
