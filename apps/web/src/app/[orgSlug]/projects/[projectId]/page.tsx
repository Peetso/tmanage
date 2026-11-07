'use client';

import { use } from 'react';
import { notFound } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ProjectOverviewScreen } from '../../../../components/screens/ProjectOverviewScreen';
import { browserApiClient } from '../../../../lib/api/browser-client';
import { isApiNotFound } from '../../../../lib/api/not-found';
import { getProject } from '../../../../lib/api/projects';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **TM-03 Project overview.**
 *
 * Under `[orgSlug]/projects/[projectId]` for the reason every tenant-scoped route is: the slug
 * in the path is the claim the API's `TenantContextGuard` resolves against a membership row
 * before any handler runs.
 *
 * B15: an unknown project id renders the 404 page, not the full overview around a project that
 * is not there. The query shares the screen's key, so it is one request, not two; a 404 is not
 * retried because asking again cannot make the project exist.
 */
export default function ProjectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);
  const project = useQuery({
    queryKey: ['project', orgSlug, projectId],
    queryFn: () => getProject(browserApiClient(), orgSlug, projectId),
    retry: (failureCount, error) => !isApiNotFound(error) && failureCount < 3,
  });

  if (project.isError && isApiNotFound(project.error)) notFound();

  return (
    <ProjectOverviewScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
