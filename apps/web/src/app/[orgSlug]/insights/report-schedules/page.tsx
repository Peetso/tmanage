'use client';

import { use } from 'react';
import { ReportSchedulesScreen } from '../../../../components/screens/ReportSchedulesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Insight report schedules** (module 15, x228).
 *
 * Under `[orgSlug]/insights/report-schedules`, matching the API route shape: the slug in the path is
 * the claim the API's `TenantContextGuard` resolves against a membership row. The screen reads and
 * writes `…/insights/report-schedules`, gated on `work.read`, so a caller without it sees the API's
 * refusal rather than a blank page. The organization name is still a fixture, for the sibling insights
 * pages' reason: no endpoint returns the current organization's profile by slug.
 */
export default function ReportSchedulesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ReportSchedulesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
