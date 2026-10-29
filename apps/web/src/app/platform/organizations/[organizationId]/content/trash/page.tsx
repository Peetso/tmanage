'use client';

import { use } from 'react';
import { PlatformContentTrashScreen } from '../../../../../../components/platform/content/TrashScreen';

/** Platform admin — B7, everything soft-deleted in the organization, with Restore. */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformContentTrashScreen organizationId={organizationId} />;
}
