'use client';

import { use } from 'react';
import { AdminFeatureFlagsScreen } from '../../../../components/screens/AdminFeatureFlagsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Per-org feature flags (Administration module 18, x278).**
 *
 * Under `[orgSlug]/admin/feature-flags`: the slug in the path is the claim the API's
 * `TenantContextGuard` resolves against a membership row, and the admin feature-flag routes sit
 * behind `org.manage`. The organization name is still a fixture, for `AdminRolesPage`'s reason: no
 * endpoint returns the current organization's profile by slug.
 */
export default function AdminFeatureFlagsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <AdminFeatureFlagsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
