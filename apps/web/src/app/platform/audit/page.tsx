'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

/**
 * `/platform/audit` (PA-02) moved to Activity & access (platform-admin v2 · PA-09): a person's
 * actions go to C1 filtered to them, everything else to C4 Platform admins.
 */
function Redirect() {
  const router = useRouter();
  const params = useSearchParams();
  const actor = params.get('actorUserId');
  useEffect(() => {
    router.replace(
      actor
        ? `/platform/activity?actorUserId=${encodeURIComponent(actor)}`
        : '/platform/activity/platform',
    );
  }, [actor, router]);
  return null;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Redirect />
    </Suspense>
  );
}
