'use client';

import { use } from 'react';
import { OrgSettingsScreen } from '../../../../components/screens/OrgSettingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Organization settings / policy (Administration module 18, x153)**, at
 * `/{orgSlug}/settings/organization` since 55-22 made `/settings` the Settings home. The settings
 * routes sit behind `org.manage`. The organization name is still a fixture, for `WorkPage`'s
 * reason: no endpoint returns the current organization's profile by slug.
 */
export default function OrgSettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <OrgSettingsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
