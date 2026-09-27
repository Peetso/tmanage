'use client';

import { use } from 'react';
import { ProjectAllocationsScreen } from '../../../../../components/screens/ProjectAllocationsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Project allocations** — PEOPLE / module 14 (x171).
 *
 * Under `[orgSlug]/projects/[projectId]/allocations`: the slug and the project id are the claims the
 * API's `TenantContextGuard` and the allocations controller resolve — the slug against a membership
 * row, the project id (and the named membership) tenant-scoped before any read or write. The screen
 * reads `GET …/projects/:id/allocations` and writes `POST …/allocations`, gated on the server by
 * `project.manage` / `work.read`, so a member without the capability sees the API's refusal rather
 * than a blank page.
 */
export default function ProjectAllocationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <ProjectAllocationsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
