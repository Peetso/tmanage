import type { Metadata } from 'next';
import { OrganizationSelectorScreen } from '../../components/screens/OrganizationSelectorScreen';
import { routeTitle } from '../../lib/route-titles';

/**
 * FIX6 locale flash: rendered per request, so the first HTML is in the member's saved language
 * (`lib/i18n/server-html-attributes.ts`) rather than the English prerender.
 */
export const dynamic = 'force-dynamic';

/** The tab's page name; `RouteDocumentTitle` writes it in the active locale. */
export const metadata: Metadata = { title: routeTitle('/organizations') };

/**
 * **ID-04 Organization selector.**
 *
 * The screen fetches its own list from `GET /v1/organizations`. It took a fixture until
 * TEN-001's second half landed; the page now passes nothing, because there is nothing left to
 * pass.
 */
export default function OrganizationsPage() {
  return <OrganizationSelectorScreen />;
}
