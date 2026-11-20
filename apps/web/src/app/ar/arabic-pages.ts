import type { ComponentType } from 'react';
import HomeRoute from '../(website)/page';
import AboutRoute from '../(website)/about/page';
import ChangelogRoute from '../(website)/changelog/page';
import ClientPortalRoute from '../(website)/client-portal/page';
import ContactRoute from '../(website)/contact/page';
import CustomersRoute from '../(website)/customers/page';
import DevelopersRoute from '../(website)/developers/page';
import DownloadRoute from '../(website)/download/page';
import FaqRoute from '../(website)/faq/page';
import FeaturesCommunicationRoute from '../(website)/features/communication/page';
import FeaturesInsightsRoute from '../(website)/features/insights/page';
import FeaturesKnowledgeRoute from '../(website)/features/knowledge/page';
import FeaturesWorkRoute from '../(website)/features/work/page';
import IntegrationsRoute from '../(website)/integrations/page';
import PrivacyRoute from '../(website)/legal/privacy/page';
import TermsRoute from '../(website)/legal/terms/page';
import PricingRoute from '../(website)/pricing/page';
import ProductRoute from '../(website)/product/page';
import ResourcesRoute from '../(website)/resources/page';
import AccessibilityRoute from '../(website)/accessibility/page';
import SecurityRoute from '../(website)/security/page';
import DataLocationRoute from '../(website)/security/data-location/page';
import DisclosureRoute from '../(website)/security/disclosure/page';
import SolutionsAgenciesRoute from '../(website)/solutions/agencies/page';
import SolutionsConsultanciesRoute from '../(website)/solutions/consultancies/page';
import SolutionsInHouseRoute from '../(website)/solutions/in-house/page';
import StatusRoute from '../(website)/status/page';
import WalkthroughRoute from '../(website)/walkthrough/page';
import type { PublicLocalizedPath } from '../../lib/i18n/public-locale-routes';

/**
 * Every public page's Arabic twin (`/ar` … `/ar/status`), prerendered at build time.
 *
 * Each renders the English route's own page component — the very module `(website)` serves — so
 * the two languages can never drift apart in content; `app/ar/layout.tsx` sets the locale.
 */
export const ARABIC_PAGES: Readonly<Record<PublicLocalizedPath, ComponentType>> = {
  '/': HomeRoute,
  '/about': AboutRoute,
  '/changelog': ChangelogRoute,
  '/client-portal': ClientPortalRoute,
  '/contact': ContactRoute,
  '/customers': CustomersRoute,
  '/developers': DevelopersRoute,
  '/download': DownloadRoute,
  '/faq': FaqRoute,
  '/features/communication': FeaturesCommunicationRoute,
  '/features/insights': FeaturesInsightsRoute,
  '/features/knowledge': FeaturesKnowledgeRoute,
  '/features/work': FeaturesWorkRoute,
  '/integrations': IntegrationsRoute,
  '/legal/privacy': PrivacyRoute,
  '/legal/terms': TermsRoute,
  '/pricing': PricingRoute,
  '/product': ProductRoute,
  '/resources': ResourcesRoute,
  '/accessibility': AccessibilityRoute,
  '/security': SecurityRoute,
  '/security/data-location': DataLocationRoute,
  '/security/disclosure': DisclosureRoute,
  '/solutions/agencies': SolutionsAgenciesRoute,
  '/solutions/consultancies': SolutionsConsultanciesRoute,
  '/solutions/in-house': SolutionsInHouseRoute,
  '/status': StatusRoute,
  '/walkthrough': WalkthroughRoute,
};
