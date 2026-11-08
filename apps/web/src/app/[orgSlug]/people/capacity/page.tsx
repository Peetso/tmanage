'use client';

import { use } from 'react';
import { PeopleCapacityScreen } from '../../../../components/screens/people-capacity/PeopleCapacityScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **People · Capacity (A13)** at `/{orgSlug}/people/capacity`. A static segment, so it wins over the
 * sibling `[membershipId]` profile route. The organization name is still the fixture every sibling
 * People screen uses: no endpoint returns the current organization's profile by slug.
 */
export default function PeopleCapacityPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <PeopleCapacityScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
