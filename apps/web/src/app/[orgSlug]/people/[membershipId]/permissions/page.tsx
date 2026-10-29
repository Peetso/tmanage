'use client';

import { use } from 'react';
import { MemberOverridesScreen } from '../../../../../components/permissions/MemberOverridesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **D8 "what can this person do" + overrides** (platform-admin v2 · PA-04), organization side.
 * The API decides who may read it (`org.manage`) and re-checks every override on save.
 */
export default function MemberPermissionsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; membershipId: string }>;
}) {
  const { orgSlug, membershipId } = use(params);
  return (
    <MemberOverridesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      membershipId={membershipId}
    />
  );
}
