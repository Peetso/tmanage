'use client';

import { MarketingLegalScreen } from '../../../components/screens/MarketingLegalScreen';

/**
 * **Terms of Service (x188).** The public terms page, routed at `/legal/terms`. The screen lives in
 * `components/screens` so a test can mount it with an injected client; this route is the thin entry
 * point. It takes no params and needs no session — the endpoint it reads is `@Public()`.
 */
export default function TermsPage() {
  return <MarketingLegalScreen doc="terms" />;
}
