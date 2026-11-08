'use client';

import { use } from 'react';
import { ProjectIterationsScreen } from '../../../../../components/screens/ProjectIterationsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Iterations (53-21).** Under `[orgSlug]/projects/[projectId]/iterations`: the slug and the
 * project id are the claims the API resolves tenant-scoped; reads are `work.read`, writes
 * `project.manage` / `work.update`, all decided by the API.
 */
export default function ProjectIterationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <ProjectIterationsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
