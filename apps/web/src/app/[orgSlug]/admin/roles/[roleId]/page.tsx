'use client';

import { use } from 'react';
import { OrgRoleMatrixScreen } from '../../../../../components/screens/RoleEditScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **D7 role matrix editor, organization side** (platform-admin v2 · PA-04). One custom role's
 * permission matrix, locked to what the editor holds; the API re-checks every change.
 */
export default function AdminRoleMatrixPage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string }>;
}) {
  const { orgSlug, roleId } = use(params);
  return (
    <OrgRoleMatrixScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      roleId={roleId}
    />
  );
}
