'use client';

import { PlatformPeopleScreen } from '../../../components/platform/PlatformAdminScreens';

/** Platform admin — find a person by email. The API decides who may see it (404 for everyone not listed). */
export default function Page() {
  return <PlatformPeopleScreen />;
}
