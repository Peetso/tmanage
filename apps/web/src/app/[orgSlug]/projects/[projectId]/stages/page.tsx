'use client';

import { use } from 'react';
import { ProjectStagesScreen } from '../../../../../components/work/stages/ProjectStagesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Project → Stages (W-WEB-5)** at `/{orgSlug}/projects/{projectId}/stages`: the project's own
 * stage set or the workspace's, and its board columns. The slug in the path is the claim the API's
 * `TenantContextGuard` resolves; the project id is resolved inside that tenant.
 */
export default function ProjectStagesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);
  return (
    <ProjectStagesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
