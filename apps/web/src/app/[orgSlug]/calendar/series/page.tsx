'use client';

import { use } from 'react';
import { MeetingSeriesScreen } from '../../../../components/screens/MeetingSeriesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Calendar → recurring meetings** (CAL recurrence, x129).
 *
 * x122 shipped the one-off meetings surface at `/calendar`; this sibling route adds the recurring
 * *series*: {@link MeetingSeriesScreen} creates a rule, lists a tenant's series and previews the dates
 * a chosen series falls on. The rail stays on Calendar (`activeNavigationId="calendar"`).
 *
 * The organization name is still a fixture, for the same reason as its sibling routes: no endpoint
 * returns the current organization's profile by slug.
 */
export default function CalendarSeriesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <MeetingSeriesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
