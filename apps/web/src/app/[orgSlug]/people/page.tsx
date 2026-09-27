'use client';

import { use } from 'react';
import { PeopleDirectoryScreen } from '../../../components/screens/PeopleDirectoryScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **People** — the People & capacity destination on the internal rail (`22-SCREEN-BY-SCREEN` §1),
 * module 14 / audit #4.
 *
 * This route was the last true `PlannedInternalScreen` stub: a named destination the rail drew
 * and could not open with anything but "not built yet". It now resolves to the member directory —
 * everyone in the organization, by name, with their role, status and project count — served by
 * `GET /v1/organizations/:orgSlug/people` behind `work.read`. The offboarding write boundary keeps
 * its own sub-route at `/people/offboarding`.
 */
export default function PeoplePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PeopleDirectoryScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
