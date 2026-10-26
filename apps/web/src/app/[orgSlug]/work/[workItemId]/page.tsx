'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { WorkItemDetailScreen } from '../../../../components/screens/WorkItemDetailScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';
// Phone (<768px) restyle of the detail (Figma 407:6635); CSS only, desktop unchanged.
import '../../../../styles/phone/work-item.css';

/**
 * **TM-13 Work item detail.**
 *
 * Both identifiers come from the path. The work item id is not a credential — the API answers
 * 404 for an item in another tenant exactly as it does for one that does not exist, which is
 * proved in `work-001-work-items.db.test.ts` — so it is safe in a URL and a link to an item is
 * a link a colleague can follow.
 *
 * Deleting the item sends the reader back to the work list through the router (P9); a
 * duplicate opens the new copy the same way (A6).
 */
export default function WorkItemPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workItemId: string }>;
}) {
  const { orgSlug, workItemId } = use(params);
  const router = useRouter();

  return (
    <WorkItemDetailScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      workItemId={workItemId}
      onDeleted={() => router.push(`/${orgSlug}/work`)}
      onOpenItem={(id) => router.push(`/${orgSlug}/work/${id}`)}
    />
  );
}
