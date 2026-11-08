'use client';

import { use } from 'react';
import { AdminBlockedFilesScreen } from '../../../../components/screens/AdminBlockedFilesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Blocked files** — 56-06 (R44 L2, Figma 578:32859): the uploads the safety check refused, with
 * delete-now. Reached from Security; reads `GET .../admin/file-safety/blocked` (`org.security.manage`).
 */
export default function AdminBlockedFilesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <AdminBlockedFilesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
