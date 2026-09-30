'use client';

import { use } from 'react';
import { ProjectBaselineView } from '../../../../../components/screens/ProjectBaselineView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Project milestone baselines** — PROJ / module 8 (x295).
 *
 * Under `[orgSlug]/projects/[projectId]/baselines`: the slug and the project id are the claims the
 * API's `TenantContextGuard` and the baseline service resolve — the slug against a membership row,
 * the project id tenant-scoped before any read or write. The screen reads
 * `GET …/projects/:id/baselines` and `…/baselines/:id/variance`, and writes `POST …/baselines` /
 * `DELETE …/baselines/:id`, all gated on the server by `project.manage`, so a member without the
 * capability sees the API's refusal rather than a blank page.
 */
export default function ProjectBaselinesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <ProjectBaselineView
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
