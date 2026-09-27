'use client';

import { use } from 'react';
import { WorkItemEstimateScreen } from '../../../../../components/screens/WorkItemEstimateScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Work item effort estimate (x258).**
 *
 * Both identifiers come from the path. The work item id is not a credential — the API answers 404
 * for an item in another tenant exactly as it does for one that does not exist — so it is safe in a
 * URL. The organization name is still a fixture, for `WorkItemPage`'s reason: no endpoint returns
 * the current organization's profile by slug.
 */
export default function WorkItemEstimatePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workItemId: string }>;
}) {
  const { orgSlug, workItemId } = use(params);

  return (
    <WorkItemEstimateScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      workItemId={workItemId}
    />
  );
}
