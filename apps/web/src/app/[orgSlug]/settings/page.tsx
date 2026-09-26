'use client';

import { use } from 'react';
import { OrgSettingsScreen } from '../../../components/screens/OrgSettingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Organization settings / policy (Administration module 18, x153).**
 *
 * Under `[orgSlug]/settings`: the slug in the path is the claim the API's `TenantContextGuard`
 * resolves against a membership row, and the settings routes sit behind `org.manage`. The
 * organization name is still a fixture, for `WorkPage`'s reason: no endpoint returns the current
 * organization's profile by slug.
 */
export default function OrgSettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <OrgSettingsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
