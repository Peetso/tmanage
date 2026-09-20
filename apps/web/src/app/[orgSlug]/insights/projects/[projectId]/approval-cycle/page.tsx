'use client';

import { use } from 'react';
import { InsightsApprovalCycleScreen } from '../../../../../../components/screens/InsightsApprovalCycleScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **Approval cycle** — INS-02's project-scoped insights read.
 *
 * Under `[orgSlug]/insights/projects/[projectId]/approval-cycle`, matching the API route shape:
 * the slug in the path is the claim the API's `TenantContextGuard` resolves against a membership
 * row, and the project id scopes the read. The screen reads
 * `GET …/insights/projects/:projectId/approval-cycle`, gated on `approval.read`, so a member
 * without it sees the API's refusal rather than a blank page.
 */
export default function InsightsApprovalCyclePage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <InsightsApprovalCycleScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
