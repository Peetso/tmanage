'use client';

import { PlatformGeneralSettingsScreen } from '../../../components/platform/settings/PlatformGeneralSettingsScreen';

/** Platform admin — Settings · General (PA-10, D1). The API decides who may see it (404 for everyone not listed). */
export default function Page() {
  return <PlatformGeneralSettingsScreen />;
}
