'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AccessLogScreen } from '../../../../components/platform/activity/AccessLogScreen';

function WithParams() {
  const params = useSearchParams();
  return <AccessLogScreen initialView={params.get('view') ?? undefined} />;
}

/** Platform admin — C3 Access: sign-ins, sessions, step-ups, suspicious (platform-admin v2 · PA-09). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <WithParams />
    </Suspense>
  );
}
