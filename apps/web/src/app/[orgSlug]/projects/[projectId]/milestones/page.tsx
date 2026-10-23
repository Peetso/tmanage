'use client';

import { use } from 'react';
import { ProjectMilestonesScreen } from '../../../../../components/screens/ProjectMilestonesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Project milestones (A9).**
 *
 * Under `[orgSlug]/projects/[projectId]/milestones` behind `project.manage`: the slug in the path is
 * the claim the API's `TenantContextGuard` resolves against a membership row before any handler runs.
 * The client sees the published ones on the portal timeline.
 */
export default function ProjectMilestonesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <ProjectMilestonesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
