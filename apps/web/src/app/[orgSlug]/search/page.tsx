'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { SearchScreen } from '../../../components/screens/SearchScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **SRCH-01 Global search.**
 *
 * The query can arrive in the URL (`?q=`), so a search is a link a colleague can be sent and the
 * screen opens straight onto its results. The organization name is still a fixture, for the
 * reason every internal page here uses one: no endpoint returns the current organization's
 * profile by slug.
 */
export default function SearchPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const search = useSearchParams();
  const q = search.get('q');

  return (
    <SearchScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(q === null ? {} : { initialQuery: q })}
    />
  );
}
