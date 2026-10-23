import type { Metadata } from 'next';
import { LEGAL_DOCUMENTS } from '@tmanage/domain';
import { MarketingLegalScreen } from '../../../../components/screens/MarketingLegalScreen';

/** The root layout's template adds ' · TManage'; `WebsiteDocumentTitle` swaps in the Arabic name. */
export const metadata: Metadata = {
  title: 'Terms of Service',
};

/**
 * **Terms of Service (x188).** The public terms page, routed at `/legal/terms` (and `/terms`, which redirects
 * here). A server component: it hands the screen the document from `@tmanage/domain`, the same
 * object the API serves, so the full text is in the server HTML — Google's OAuth brand review reads
 * the page without running JavaScript. Statically generated at build time.
 */
export default function TermsPage() {
  return <MarketingLegalScreen doc="terms" document={LEGAL_DOCUMENTS.terms} />;
}
