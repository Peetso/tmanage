'use client';

import { use } from 'react';
import { WorkItemLinksScreen } from '../../../../../components/screens/WorkItemLinksScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Work item links (56-07).** Both identifiers come from the path; the work item id is not a
 * credential (the API answers 404 for an item in another tenant exactly as for a missing one).
 */
export default function WorkItemLinksPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workItemId: string }>;
}) {
  const { orgSlug, workItemId } = use(params);

  return (
    <WorkItemLinksScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      workItemId={workItemId}
    />
  );
}
