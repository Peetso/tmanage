import type { Metadata } from 'next';
import { LEGAL_DOCUMENTS as DOMAIN_LEGAL_DOCUMENTS } from '@tmanage/domain';
import { MarketingLegalScreen } from '../../../../components/screens/MarketingLegalScreen';
import { translate } from '../../../../lib/i18n/t';

/** The root layout's template adds ' · TManage'; `WebsiteDocumentTitle` swaps in the Arabic name. */
export const metadata: Metadata = {
  title: 'Privacy Policy',
};

/**
 * R12: what sign-in data is kept — the IP, its approximate place and the automation hint — who sees
 * it and how long. Added after the domain's sections, in English like the server HTML.
 */
const SIGN_IN_SECTION = {
  id: 'sign-in-data',
  heading: translate('en', 'Privacy.signInHeading'),
  body: translate('en', 'Privacy.signInBody'),
};

/** The domain's documents, with the privacy policy carrying the sign-in section at its end. */
const LEGAL_DOCUMENTS = {
  privacy: {
    ...DOMAIN_LEGAL_DOCUMENTS.privacy,
    sections: [...DOMAIN_LEGAL_DOCUMENTS.privacy.sections, SIGN_IN_SECTION],
  },
};

/**
 * **Privacy Policy (x188).** The public privacy page, routed at `/legal/privacy` (and `/privacy`, which redirects
 * here). A server component: it hands the screen the document from `@tmanage/domain`, the same
 * object the API serves, so the full text is in the server HTML — Google's OAuth brand review reads
 * the page without running JavaScript. Statically generated at build time.
 */
export default function PrivacyPage() {
  return <MarketingLegalScreen doc="privacy" document={LEGAL_DOCUMENTS.privacy} />;
}
