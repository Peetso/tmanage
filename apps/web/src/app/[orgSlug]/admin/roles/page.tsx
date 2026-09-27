'use client';

import { use } from 'react';
import { AdminRolesScreen } from '../../../../components/screens/AdminRolesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Custom roles (Administration module 18, x173).**
 *
 * Under `[orgSlug]/admin/roles`: the slug in the path is the claim the API's `TenantContextGuard`
 * resolves against a membership row, and the roles routes sit behind `org.manage`. The organization name
 * is still a fixture, for `OrgSettingsPage`'s reason: no endpoint returns the current organization's
 * profile by slug.
 */
export default function AdminRolesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AdminRolesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
