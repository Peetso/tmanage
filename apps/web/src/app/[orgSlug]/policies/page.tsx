'use client';

import { use } from 'react';
import { AdminPoliciesScreen } from '../../../components/screens/AdminPoliciesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Organization access policies (Administration module 18, x174).**
 *
 * Under `[orgSlug]/policies`: the slug in the path is the claim the API's `TenantContextGuard` resolves
 * against a membership row, and the access-policy routes sit behind `org.manage`. The organization name
 * is still a fixture, for `WorkPage`'s reason: no endpoint returns the current organization's profile by
 * slug.
 */
export default function AdminPoliciesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AdminPoliciesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
