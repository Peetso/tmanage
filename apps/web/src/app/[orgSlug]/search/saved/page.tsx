'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { SavedSearchesScreen } from '../../../../components/screens/SavedSearchesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **SRCH saved & recent searches (x214)** — SR-04.
 *
 * A query can arrive in the URL (`?q=`): SR-02's "Save this search" opens this screen with the
 * new-search form already holding it. The organization name is still a fixture, for
 * `SearchPage`'s reason: no endpoint returns the current organization's profile by slug.
 */
export default function SavedSearchesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const q = useSearchParams().get('q');

  return (
    <SavedSearchesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(q === null ? {} : { initialQuery: q })}
    />
  );
}
