'use client';

import { use } from 'react';
import { SavedSearchesScreen } from '../../../../components/screens/SavedSearchesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **SRCH saved & recent searches (x214).**
 *
 * The saved/recent surface for the Search module. The organization name is still a fixture, for
 * `SearchPage`'s reason: no endpoint returns the current organization's profile by slug.
 */
export default function SavedSearchesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <SavedSearchesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
