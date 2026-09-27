'use client';

import { use } from 'react';
import { SearchPinsView } from '../../../../components/screens/SearchPinsView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **SRCH quick-access pins (x290).**
 *
 * The pinned-results surface for the Search module. The organization name is still a fixture, for
 * `SearchPage`'s reason: no endpoint returns the current organization's profile by slug.
 */
export default function SearchPinsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return <SearchPinsView organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
