'use client';

import { use } from 'react';
import { InsightMetricAlertsScreen } from '../../../../components/screens/InsightMetricAlertsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Insight metric alerts** (module 15, x319).
 *
 * Under `[orgSlug]/insights/metric-alerts`, matching the API route shape: the slug in the path is the
 * claim the API's `TenantContextGuard` resolves against a membership row. The screen reads and writes
 * `…/insights/metric-alerts` (gated on `work.read`, self-scoped), so a caller without the capability
 * sees the API's refusal rather than a blank page. The organization name is still a fixture, for the
 * sibling insights pages' reason: no endpoint returns the current organization's profile by slug.
 */
export default function InsightMetricAlertsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <InsightMetricAlertsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
