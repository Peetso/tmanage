import type { Metadata } from 'next';
import { StatusScreen } from '../../components/screens/StatusScreen';

/**
 * **Public status page** — Public & trust site, module 1 (x159).
 *
 * A top-level, public route: it sits outside `[orgSlug]` because it names no organization and needs
 * no session, like `/sign-in` and `/recover`. It renders `StatusScreen`, which reads the public
 * `GET /v1/public/site/status` endpoint. There is no server-side fetch here — the read is public and
 * client-side, so the page is a thin shell over the screen, matching the other standalone routes.
 */
export const metadata: Metadata = {
  title: 'Service status',
  description: 'The current status of the service and any recent incidents.',
};

export default function StatusPage() {
  return <StatusScreen />;
}
