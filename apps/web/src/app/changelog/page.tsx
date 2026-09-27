import { ChangelogScreen } from '../../components/screens/ChangelogScreen';

/**
 * **Public changelog / product updates (x160).**
 *
 * A top-level, tenant-free route (`/changelog`) — not under `[orgSlug]` — because the changelog is
 * public marketing-site content read before anyone has chosen an organization. It renders
 * {@link ChangelogScreen}, which fetches the `@Public()` API route with no session.
 */
export default function ChangelogPage() {
  return <ChangelogScreen />;
}
