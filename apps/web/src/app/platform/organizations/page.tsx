'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PlatformOrgListScreen } from '../../../components/platform/organizations/PlatformOrgListScreen';

function ListWithParams() {
  const params = useSearchParams();
  return <PlatformOrgListScreen startWithNew={params.get('new') === '1'} />;
}

/** Platform admin — A2, every organization on TManage. `?new=1` opens New organization. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <ListWithParams />
    </Suspense>
  );
}
