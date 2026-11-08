'use client';

import { use } from 'react';
import { InsightsWorkloadHoursScreen } from '../../../../components/screens/InsightsWorkloadHoursScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Workload in hours** (A14) — planned hours this week against each person's weekly capacity,
 * with owner/admin-editable capacity. Reads `GET …/insights/workload-hours` (`report.view`).
 */
export default function InsightsWorkloadPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <InsightsWorkloadHoursScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
