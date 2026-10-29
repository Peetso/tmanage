'use client';

import { PlatformOrgOverviewScreen } from '../../components/platform/organizations/PlatformOrgOverviewScreen';

/** Platform admin — A1, the health of every organization. The API decides who may see it (404 for everyone not listed). */
export default function Page() {
  return <PlatformOrgOverviewScreen />;
}
