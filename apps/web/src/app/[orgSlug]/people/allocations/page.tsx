'use client';

import { use } from 'react';
import { PeopleAllocationsScreen } from '../../../../components/screens/people-capacity/PeopleAllocationsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **People · Allocations (A13)** at `/{orgSlug}/people/allocations`. A static segment, so it wins over the
 * sibling `[membershipId]` profile route. The organization name is still the fixture every sibling
 * People screen uses: no endpoint returns the current organization's profile by slug.
 */
export default function PeopleAllocationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <PeopleAllocationsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
