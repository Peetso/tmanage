import type { Metadata } from 'next';
import { MarketingResourcesScreen } from '../../components/screens/MarketingResourcesScreen';

/**
 * **Public resources / guides index** — Public & trust site, module 1 (x187).
 *
 * A top-level, tenant-free route (`/resources`) — not under `[orgSlug]` — because the resource
 * library is public marketing-site content read before anyone has chosen an organization, like
 * `/changelog` and `/status`. It renders {@link MarketingResourcesScreen}, which reads the
 * `@Public()` API route with no session.
 */
export const metadata: Metadata = {
  title: 'Resources & guides',
  description: 'Guides and reference for getting the most out of TManage.',
};

export default function ResourcesPage() {
  return <MarketingResourcesScreen />;
}
