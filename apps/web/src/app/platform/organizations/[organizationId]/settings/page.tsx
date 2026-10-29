'use client';

import { use } from 'react';
import { PlatformOrgSettingsScreen } from '../../../../../components/platform/organizations/PlatformOrgSettingsScreen';

/** Platform admin — A4, profile, settings, policy and flags. */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformOrgSettingsScreen organizationId={organizationId} />;
}
