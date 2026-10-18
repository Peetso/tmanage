'use client';

import { PlatformAuditScreen } from '../../../components/platform/PlatformAdminScreens';

/** Platform admin — the platform audit log. The API decides who may see it (404 for everyone not listed). */
export default function Page() {
  return <PlatformAuditScreen />;
}
