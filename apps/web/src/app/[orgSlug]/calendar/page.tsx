'use client';

import { use } from 'react';
import { MeetingsScreen } from '../../../components/screens/MeetingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Calendar** — the fifth destination on the internal rail (`22-SCREEN-BY-SCREEN` §1).
 *
 * Opens on **All meetings** (approved Figma 414:6710): every meeting the person may read, in a
 * week by default. `?view=day|month` opens another range and `?project=<id>` preselects a project,
 * so a project screen (or a shared link) can open straight onto that project's meetings.
 *
 * The organization name is still a fixture, for the same reason as its sibling routes: no endpoint
 * returns the current organization's profile by slug.
 */
export default function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ project?: string | string[]; view?: string | string[] }>;
}) {
  const { orgSlug } = use(params);
  const { project, view } = use(searchParams);
  const initialProjectId = typeof project === 'string' ? project : undefined;
  const initialRange = view === 'day' || view === 'month' || view === 'week' ? view : undefined;

  return (
    <MeetingsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(initialProjectId ? { initialProjectId } : {})}
      {...(initialRange ? { initialRange } : {})}
    />
  );
}
