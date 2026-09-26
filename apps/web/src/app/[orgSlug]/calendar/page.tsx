'use client';

import { use } from 'react';
import { MeetingsScreen } from '../../../components/screens/MeetingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Calendar** — the fifth destination on the internal rail (`22-SCREEN-BY-SCREEN` §1).
 *
 * x90 landed the meetings API and x105/x108 the notes read screen, but this route stayed a
 * `PlannedInternalScreen` stub — backend-only, no UI, no journey (audit Top-10 #8). x122 builds
 * the missing list/create surface: {@link MeetingsScreen} chooses a project, lists that project's
 * meetings, schedules a new one, and links each row to its notes page. The rail stays intact —
 * `activeNavigationId="calendar"` — the destination is now answered rather than deferred.
 *
 * The organization name is still a fixture, for the same reason as its sibling routes: no endpoint
 * returns the current organization's profile by slug.
 */
export default function CalendarPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <MeetingsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
