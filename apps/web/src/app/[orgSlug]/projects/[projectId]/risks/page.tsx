'use client';

import { use } from 'react';
import { ProjectRisksScreen } from '../../../../../components/screens/ProjectRisksScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Project risks — internal compose (x140).**
 *
 * Under `[orgSlug]/projects/[projectId]/risks` behind `project.manage`: the slug in the path is the
 * claim the API's `TenantContextGuard` resolves against a membership row before any handler runs. The
 * client-facing published view is `/portal/risks`.
 */
export default function ProjectRisksPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <ProjectRisksScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
