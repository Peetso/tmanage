'use client';

import { PlatformCompaniesScreen } from '../../../components/platform/PlatformAdminScreens';

/** Platform admin — every company on TManage, metadata only. The API decides who may see it (404 for everyone not listed). */
export default function Page() {
  return <PlatformCompaniesScreen />;
}
