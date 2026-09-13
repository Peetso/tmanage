'use client';

import { use } from 'react';
import { PlannedInternalScreen } from '../../../components/screens/PlannedInternalScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Insights** — the eighth destination on the internal rail (`22-SCREEN-BY-SCREEN` §1).
 *
 * No ticket schedules an insights screen, so this route names none. It resolves to the shell so
 * the rail stays reachable and the destination stays named, and says the screen is not built —
 * a metrics screen with invented numbers would be the worst of the options.
 */
export default function InsightsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedInternalScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="insights"
      title="Insights"
      description="How your work is trending."
    >
      Insights is named in the navigation but has no screen and no scheduled backlog ticket yet.
      This page keeps the destination reachable rather than answering it with a 404, and shows no
      numbers rather than invented ones.
    </PlannedInternalScreen>
  );
}
