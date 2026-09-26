'use client';

import { use } from 'react';
import { WorkSavedViewsScreen } from '../../../../components/screens/WorkSavedViewsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **WK-08 Saved views.**
 *
 * The saved-view editor for the Work module. The organization name is still a fixture, for
 * `WorkPage`'s reason: no endpoint returns the current organization's profile by slug.
 */
export default function WorkSavedViewsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <WorkSavedViewsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
