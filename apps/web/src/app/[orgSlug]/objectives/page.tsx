'use client';

import { use } from 'react';
import { OrgObjectivesScreen } from '../../../components/screens/OrgObjectivesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Organization objectives** — PROJ / module 8 (x136).
 *
 * Under `[orgSlug]/objectives` (org-scoped, no project segment — the org-level counterpart of x124's
 * `[orgSlug]/projects/[projectId]/objectives`): the slug is the claim the API's `TenantContextGuard`
 * resolves against a membership row. The screen reads `GET …/objectives` and writes
 * `POST …/objectives` / `PATCH …/objectives/:id`, gated on the server by `project.manage` / `work.read`,
 * so a member without the capability sees the API's refusal rather than a blank page.
 */
export default function OrgObjectivesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <OrgObjectivesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
