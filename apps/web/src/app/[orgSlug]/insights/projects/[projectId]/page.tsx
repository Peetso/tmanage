'use client';

import { use } from 'react';
import { InsightsScreen } from '../../../../../components/screens/InsightsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Insights** — INS's project insights dashboard, the read half of x89 + x96 turned into a screen.
 *
 * Under `[orgSlug]/insights/projects/[projectId]`, matching the API route shape: the slug in the
 * path is the claim the API's `TenantContextGuard` resolves against a membership row, and the
 * project id scopes both reads. The screen reads the delivery-flow endpoint (gated on `work.read`)
 * and the approval-cycle endpoint (gated on `approval.read`); a member without a capability sees
 * that read's API refusal rather than a blank page, and each read is refused independently.
 */
export default function InsightsProjectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <InsightsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
