'use client';

import { use } from 'react';
import { AdminStorageScreen } from '../../../../components/screens/AdminStorageScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Control > Storage** (migration 0210): TManage storage or the company's Google Drive.
 *
 * Under `[orgSlug]/admin/storage`, behind `org.manage` on the API. Google's consent screen returns
 * here (through the API's callback), with its answer in the URL fragment.
 */
export default function AdminStoragePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <AdminStorageScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
