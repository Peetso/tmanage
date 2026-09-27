'use client';

import { use } from 'react';
import { ProjectTemplatesScreen } from '../../../../components/screens/ProjectTemplatesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Project templates** — PROJ / module 8 (x234).
 *
 * Under `[orgSlug]/projects/templates` (org-scoped, a static segment beside `[projectId]`): the slug is
 * the claim the API's `TenantContextGuard` resolves against a membership row. The screen reads
 * `GET …/projects/templates` and writes `POST …/projects/templates` / `POST …/:id/instantiate`, gated on
 * the server by `project.manage`, so a member without the capability sees the API's refusal rather than
 * a blank page.
 */
export default function ProjectTemplatesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ProjectTemplatesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
