'use client';

import { use } from 'react';
import { CalendarGridScreen } from '../../../../components/screens/CalendarGridScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Calendar week/month grid (x212).**
 *
 * The week/month grid beside the meetings list (`/calendar`) and the agenda (`/calendar/agenda`):
 * the tenant's meetings and recurrence series laid out on a fixed window. No project id in the URL —
 * the grid is cross-project by definition.
 *
 * The organization name is still a fixture, for `CalendarPage`'s reason: no endpoint returns the
 * current organization's profile by slug.
 */
export default function CalendarGridPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const { orgSlug } = use(params);
  // The header's Week / Month switch links to `?range=week|month`; anything else opens the month.
  const { range } = use(searchParams);
  const initialRange = range === 'week' ? 'week' : 'month';

  return (
    <CalendarGridScreen
      // Remount on a switch so the screen's window state starts from the new range.
      key={initialRange}
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      initialRange={initialRange}
    />
  );
}
