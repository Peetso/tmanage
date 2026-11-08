'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PlatformOwnerNoticesScreen } from '../../../components/platform/governance/PlatformGovernanceScreens';

function WithParams() {
  const params = useSearchParams();
  return <PlatformOwnerNoticesScreen organizationId={params.get('organizationId') ?? ''} />;
}

/** Platform admin — a notice to one company owner (56-21, R46 L2). `?organizationId=` preselects. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <WithParams />
    </Suspense>
  );
}
