'use client';

import { use } from 'react';
import { PlatformOrgMembersScreen } from '../../../../../components/platform/organizations/PlatformOrgMembersScreen';

/** Platform admin — A6, internal people, clients and invitations. */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformOrgMembersScreen organizationId={organizationId} />;
}
