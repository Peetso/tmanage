'use client';

import { use } from 'react';
import { ProjectGithubScreen } from '../../../../../components/screens/ProjectGithubScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Project settings · GitHub** (R45 L3, 54-10) at `/{orgSlug}/projects/{projectId}/github`: the
 * repositories linked to this project, link and unlink. The API gates every call on `org.manage`.
 */
export default function ProjectGithubPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);
  return (
    <ProjectGithubScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
