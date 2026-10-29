'use client';

import { use } from 'react';
import { PlatformOrgDetailScreen } from '../../../../components/platform/organizations/PlatformOrgDetailScreen';

/** Platform admin — A3, one organization at a glance. */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformOrgDetailScreen organizationId={organizationId} />;
}
