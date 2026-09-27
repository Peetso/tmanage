'use client';

import { use } from 'react';
import { SavedInsightViewsScreen } from '../../../../components/screens/SavedInsightViewsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Saved insight views** (module 15, x210).
 *
 * Under `[orgSlug]/insights/saved-views`, matching the API route shape: the slug in the path is the
 * claim the API's `TenantContextGuard` resolves against a membership row. The screen reads and writes
 * `…/insights/saved-views`, gated on `work.read`, so a caller without it sees the API's refusal rather
 * than a blank page. The organization name is still a fixture, for the sibling insights pages' reason:
 * no endpoint returns the current organization's profile by slug.
 */
export default function SavedInsightViewsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <SavedInsightViewsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
