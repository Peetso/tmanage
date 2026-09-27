'use client';

import { use } from 'react';
import { InsightCustomReportsView } from '../../../../components/screens/InsightCustomReportsView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Custom insight reports** (module 15, x320).
 *
 * Under `[orgSlug]/insights/custom-reports`, matching the API route shape: the slug in the path is the
 * claim the API's `TenantContextGuard` resolves against a membership row. The screen reads and writes
 * `…/insights/custom-reports` (all gated on `work.read`, self-scoped to the caller), so a caller
 * without the capability sees the API's refusal rather than a blank page. The organization name is
 * still a fixture, for the sibling insights pages' reason: no endpoint returns the current
 * organization's profile by slug.
 */
export default function InsightCustomReportsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <InsightCustomReportsView
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
