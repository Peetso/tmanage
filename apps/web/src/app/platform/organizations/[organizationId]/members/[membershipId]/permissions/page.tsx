'use client';

import { use } from 'react';
import { PlatformMemberOverridesScreen } from '../../../../../../../components/permissions/MemberOverridesScreen';

/** Platform admin — D8 for one member of one organization (platform-admin v2 · PA-04). */
export default function Page({
  params,
}: {
  params: Promise<{ organizationId: string; membershipId: string }>;
}) {
  const { organizationId, membershipId } = use(params);
  return (
    <PlatformMemberOverridesScreen organizationId={organizationId} membershipId={membershipId} />
  );
}
