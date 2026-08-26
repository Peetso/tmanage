'use client';

import { use } from 'react';
import { ProjectOverviewScreen } from '../../../../components/screens/ProjectOverviewScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **TM-03 Project overview.**
 *
 * Under `[orgSlug]/projects/[projectId]` for the reason every tenant-scoped route is: the slug
 * in the path is the claim the API's `TenantContextGuard` resolves against a membership row
 * before any handler runs.
 */
export default function ProjectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <ProjectOverviewScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
