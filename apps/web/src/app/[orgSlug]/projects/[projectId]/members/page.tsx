'use client';

import { use } from 'react';
import { MembersAndRolesScreen } from '../../../../../components/screens/MembersAndRolesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **ADM-02 Members and roles.**
 *
 * Under `[orgSlug]/projects/[projectId]/members`, disjoint from the onboarding invite flow: the
 * slug in the path is the claim the API's `TenantContextGuard` resolves against a membership row,
 * and the project id is resolved inside that tenant before any member write.
 */
export default function MembersAndRolesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = use(params);

  return (
    <MembersAndRolesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      projectId={projectId}
    />
  );
}
