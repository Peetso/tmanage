'use client';

import { use } from 'react';
import { PlannedInternalScreen } from '../../../components/screens/PlannedInternalScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **People** — the seventh destination on the internal rail (`22-SCREEN-BY-SCREEN` §1).
 *
 * A member directory is the surface `D16` needs so ownership can be assigned by name rather
 * than a pasted id, and no endpoint returns one yet; no ticket schedules the screen either, so
 * this route names none. It resolves to the shell — rail reachable, destination named — and
 * says the screen is not built.
 */
export default function PeoplePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedInternalScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="people"
      title="People"
      description="Everyone in your organization."
    >
      People is named in the navigation but has no screen and no scheduled backlog ticket yet, and
      no endpoint returns a member directory. This page keeps the destination reachable rather than
      answering it with a 404.
    </PlannedInternalScreen>
  );
}
