import { LEGAL_DOCUMENTS } from '@tmanage/domain';
import { MarketingLegalScreen } from '../../../../components/screens/MarketingLegalScreen';

/**
 * **Privacy Policy (x188).** The public privacy page, routed at `/legal/privacy` (and `/privacy`, which redirects
 * here). A server component: it hands the screen the document from `@tmanage/domain`, the same
 * object the API serves, so the full text is in the server HTML — Google's OAuth brand review reads
 * the page without running JavaScript. Statically generated at build time.
 */
export default function PrivacyPage() {
  return <MarketingLegalScreen doc="privacy" document={LEGAL_DOCUMENTS.privacy} />;
}
