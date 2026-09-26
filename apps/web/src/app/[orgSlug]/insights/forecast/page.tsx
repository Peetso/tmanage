'use client';

import { use } from 'react';
import { InsightsForecastScreen } from '../../../../components/screens/InsightsForecastScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Workload forecast** — x134's org-wide insights read.
 *
 * Under `[orgSlug]/insights/forecast`, matching the API route shape: the slug in the path is the
 * claim the API's `TenantContextGuard` resolves against a membership row. The screen reads
 * `GET …/insights/workload-forecast`, gated on `work.read`, so a member without it sees the API's
 * refusal rather than a blank page. Unlike the project-scoped insights routes, the forecast is
 * org-wide and takes no project id.
 */
export default function InsightsForecastPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <InsightsForecastScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
