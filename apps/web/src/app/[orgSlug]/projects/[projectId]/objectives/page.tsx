'use client';

import { use } from 'react';
import { ProjectObjectivesScreen } from '../../../../../components/screens/ProjectObjectivesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Project objectives** — PROJ / module 8 (x124).
 *
 * Under `[orgSlug]/projects/[projectId]/objectives`: the slug and the project id are the claims the
 * API's `TenantContextGuard` and the objectives service resolve — the slug against a membership row,
 * the project id tenant-scoped before any read or write. The screen reads
 * `GET …/projects/:id/objectives` and writes `POST …/objectives` / `PATCH …/objectives/:id`, gated on
 * the server by `project.manage` / `work.read`, so a member without the capability sees the API's
 * refusal rather than a blank page.
 */
export default function ProjectObjectivesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <ProjectObjectivesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
