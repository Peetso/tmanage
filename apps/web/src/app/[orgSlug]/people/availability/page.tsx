'use client';

import { use } from 'react';
import { AvailabilityScreen } from '../../../../components/screens/AvailabilityScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Member availability / out-of-office (module 14 People & capacity, x218).**
 *
 * The member's own out-of-office windows, at `/{orgSlug}/people/availability`. The organization name
 * is still a fixture, the reason every sibling screen gives: no endpoint returns the current
 * organization's profile by slug.
 */
export default function AvailabilityPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <AvailabilityScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
