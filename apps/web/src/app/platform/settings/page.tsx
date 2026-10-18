'use client';

import { PlatformSettingsScreen } from '../../../components/platform/PlatformAdminScreens';

/** Platform admin — platform switches (public sign-up). The API decides who may see it (404 for everyone not listed). */
export default function Page() {
  return <PlatformSettingsScreen />;
}
