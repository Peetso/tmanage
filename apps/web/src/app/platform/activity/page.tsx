'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import {
  ACTION_FILTER_KEYS,
  ActionLogScreen,
} from '../../../components/platform/activity/ActionLogScreen';

function WithParams() {
  const params = useSearchParams();
  const filter: Record<string, string> = {};
  for (const key of ACTION_FILTER_KEYS) {
    const value = params.get(key);
    if (value) filter[key] = value;
  }
  return <ActionLogScreen key={params.toString()} initialFilter={filter} />;
}

/** Platform admin — C1 Actions: every organization's action log (platform-admin v2 · PA-09). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <WithParams />
    </Suspense>
  );
}
