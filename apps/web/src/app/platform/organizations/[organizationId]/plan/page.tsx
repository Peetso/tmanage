'use client';

import { use } from 'react';
import { PlatformOrgPlanScreen } from '../../../../../components/platform/organizations/PlatformOrgPlanScreen';

/** Platform admin — A5, plan, billing mode, limits and storage. */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformOrgPlanScreen organizationId={organizationId} />;
}
