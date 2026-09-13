'use client';

import { use } from 'react';
import { PlannedInternalScreen } from '../../../components/screens/PlannedInternalScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Home** — the first destination on the internal rail (`22-SCREEN-BY-SCREEN` §1), and the
 * target of the rail's brand link (`AppShell` points it at `/{slug}/home`).
 *
 * The screen itself is `HOME-001`'s My Day — a ranked, explained list of what needs the
 * person today — and it is not built. Until it is, this route resolves to the shell with the
 * rail intact and says so, rather than leaving the rail's own first item and its wordmark
 * pointing at a 404.
 */
export default function HomePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedInternalScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="home"
      title="Home"
      description="Your day at a glance."
      ticket="HOME-001"
    >
      Home is the ranked, explained My Day view of what needs you today. It is not built yet; when
      it is, this is where it will open.
    </PlannedInternalScreen>
  );
}
