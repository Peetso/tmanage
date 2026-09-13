'use client';

import { use } from 'react';
import { PlannedInternalScreen } from '../../../components/screens/PlannedInternalScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Docs** — the sixth destination on the internal rail (`22-SCREEN-BY-SCREEN` §1).
 *
 * No ticket schedules a docs screen, so this route names none. It resolves to the shell so the
 * rail stays reachable and the destination stays named, and states that the screen is unbuilt.
 */
export default function DocsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedInternalScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="docs"
      title="Docs"
      description="Shared documents for your team."
    >
      Docs is named in the navigation but has no screen and no scheduled backlog ticket yet. This
      page keeps the destination reachable rather than answering it with a 404.
    </PlannedInternalScreen>
  );
}
