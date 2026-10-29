'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PlatformActionsScreen } from '../../../../components/platform/activity/PlatformActionsScreen';

const KEYS = ['adminId', 'action', 'organizationId', 'from', 'to', 'q'] as const;

function WithParams() {
  const params = useSearchParams();
  const filter: Record<string, string> = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value) filter[key] = value;
  }
  return <PlatformActionsScreen key={params.toString()} initialFilter={filter} />;
}

/** Platform admin — C4 Platform admins: what the operators did (platform-admin v2 · PA-09). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <WithParams />
    </Suspense>
  );
}
