'use client';

import { use } from 'react';
import { MeetingAgendaScreen } from '../../../../components/screens/MeetingAgendaScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Calendar agenda / day view (x127).**
 *
 * The read-only agenda beside the meetings list (`/calendar`): the tenant's meetings grouped by the
 * day they start on, across a range. No project id in the URL — the agenda is cross-project by
 * definition.
 *
 * The organization name is still a fixture, for `CalendarPage`'s reason: no endpoint returns the
 * current organization's profile by slug.
 */
export default function CalendarAgendaPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <MeetingAgendaScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
