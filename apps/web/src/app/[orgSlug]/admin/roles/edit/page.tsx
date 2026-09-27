'use client';

import { use } from 'react';
import { RoleEditScreen } from '../../../../../components/screens/RoleEditScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Custom role clone + edit (Administration module 18, x195).**
 *
 * Under `[orgSlug]/admin/roles/edit`, distinct from x173's `[orgSlug]/admin/roles` create/list route:
 * the slug in the path is the claim the API's `TenantContextGuard` resolves against a membership row, and
 * the clone/edit routes sit behind `org.manage`. The organization name is still a fixture, for
 * `AdminRolesPage`'s reason: no endpoint returns the current organization's profile by slug.
 */
export default function AdminRoleEditPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return <RoleEditScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
