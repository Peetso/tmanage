'use client';

import { use } from 'react';
import { PlannedInternalScreen } from '../../../components/screens/PlannedInternalScreen';
import { InsightsExportButton } from '../../../components/screens/InsightsExportButton';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Insights** — the eighth destination on the internal rail (`22-SCREEN-BY-SCREEN` §1).
 *
 * No ticket schedules the full insights screen, so this route names none. It resolves to the shell
 * so the rail stays reachable and the destination stays named, and shows no invented numbers. The
 * one thing it can already offer honestly is INS-05's org-wide workload roll-up (x123) as a CSV
 * download — a read-only export behind `work.read`, wired here rather than left API-only.
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
      The full insights screen has no scheduled backlog ticket yet, so this page shows no numbers
      rather than invented ones. You can export the org-wide workload roll-up — open work by project
      across the projects you can read — as a CSV.
      <InsightsExportButton organizationSlug={orgSlug} />
    </PlannedInternalScreen>
  );
}
