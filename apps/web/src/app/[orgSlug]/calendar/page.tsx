'use client';

import { use } from 'react';
import { PlannedInternalScreen } from '../../../components/screens/PlannedInternalScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Calendar** — the fifth destination on the internal rail (`22-SCREEN-BY-SCREEN` §1).
 *
 * No ticket in `28-SPRINT-TICKETS-AND-ESTIMATES.md` schedules a calendar screen, so this
 * route names no ticket rather than inventing one. It resolves to the shell so the rail stays
 * reachable and the destination stays named, and says plainly that the screen is not built.
 */
export default function CalendarPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedInternalScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="calendar"
      title="Calendar"
      description="Dates and commitments across your work."
    >
      Calendar is named in the navigation but has no screen and no scheduled backlog ticket yet.
      This page keeps the destination reachable rather than answering it with a 404.
    </PlannedInternalScreen>
  );
}
