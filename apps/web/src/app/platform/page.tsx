'use client';

import { PlatformOverviewScreen } from '../../components/platform/PlatformAdminScreens';

/** Platform admin — the overview of the whole service. The API decides who may see it (404 for everyone not listed). */
export default function Page() {
  return <PlatformOverviewScreen />;
}
