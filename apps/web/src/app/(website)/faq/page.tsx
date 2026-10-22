import type { Metadata } from 'next';
import { MarketingFaqScreen } from '../../../components/screens/MarketingFaqScreen';

/** The root layout's template adds ' · TManage'. */
export const metadata: Metadata = {
  title: 'FAQ',
};

/**
 * **Public FAQ page** (x186), module 1 — routed at `/faq`.
 *
 * A public, unauthenticated route: no organization slug, no session. The screen fetches the API's
 * code-defined FAQ content and renders it as an accordion. Kept as a thin route so a test mounts the
 * screen directly, as the other public screens are.
 */
export default function FaqPage() {
  return <MarketingFaqScreen />;
}
