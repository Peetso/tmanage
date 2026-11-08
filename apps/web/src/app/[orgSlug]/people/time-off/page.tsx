'use client';

import { use } from 'react';
import { PeopleTimeOffScreen } from '../../../../components/screens/people-capacity/PeopleTimeOffScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **People · Time off (A13)** at `/{orgSlug}/people/time-off`. A static segment, so it wins over the
 * sibling `[membershipId]` profile route. The organization name is still the fixture every sibling
 * People screen uses: no endpoint returns the current organization's profile by slug.
 */
export default function PeopleTimeOffPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <PeopleTimeOffScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
