'use client';

import { use } from 'react';
import { PlatformOrgLifecycleScreen } from '../../../../../components/platform/organizations/PlatformOrgLifecycleScreen';

/** Platform admin — A7, suspend, transfer, archive and delete. */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformOrgLifecycleScreen organizationId={organizationId} />;
}
