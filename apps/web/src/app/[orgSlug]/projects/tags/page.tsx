'use client';

import { use } from 'react';
import { ProjectTagsScreen } from '../../../../components/screens/ProjectTagsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Project tags** — Projects / portfolio module (x267).
 *
 * Under `[orgSlug]/projects/tags`: `tags` is a static segment, so Next.js matches it before the
 * sibling `[orgSlug]/projects/[projectId]` and never reads it as a project id (the same way
 * `projects/portfolio` sits beside it). The slug is the claim the API's `TenantContextGuard` resolves
 * against a membership row; the screen reads `GET …/projects/tags` and writes `POST …/projects/tags`,
 * gated on the server by `work.read` / `project.manage`, so a member without the capability sees the
 * API's refusal rather than a blank page.
 */
export default function ProjectTagsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ProjectTagsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
