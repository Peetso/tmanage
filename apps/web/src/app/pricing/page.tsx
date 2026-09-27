'use client';

import { PricingScreen } from '../../components/screens/PricingScreen';

/**
 * **Pricing (x157).** The public pricing page. The screen itself lives in `components/screens` so a
 * test can mount it with an injected client; this route is the thin entry point. It takes no params
 * and needs no session — the endpoint it reads is `@Public()`.
 */
export default function PricingPage() {
  return <PricingScreen />;
}
