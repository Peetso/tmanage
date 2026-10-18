'use client';

import { use } from 'react';
import { PlatformCompanyScreen } from '../../../../components/platform/PlatformAdminScreens';

/** Platform admin — one company's metadata and its admin/security events, never its content. */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformCompanyScreen organizationId={organizationId} />;
}
