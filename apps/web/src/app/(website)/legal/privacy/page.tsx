'use client';

import { MarketingLegalScreen } from '../../../../components/screens/MarketingLegalScreen';

/**
 * **Privacy Policy (x188).** The public privacy page, routed at `/legal/privacy`. The screen lives in
 * `components/screens` so a test can mount it with an injected client; this route is the thin entry
 * point. It takes no params and needs no session — the endpoint it reads is `@Public()`.
 */
export default function PrivacyPage() {
  return <MarketingLegalScreen doc="privacy" />;
}
