'use client';

import { use } from 'react';
import { PortalPeopleScreen } from '../../../../components/screens/PortalPeopleScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **People** — the client portal's team screen (`22-SCREEN-BY-SCREEN` §1, x142).
 *
 * Until x142 this route resolved to `PlannedPortalScreen`: no endpoint returned the client-visible
 * members of a project, so the tab was named but unbuilt. `GET /portal/projects/:projectId/people`
 * now returns the name-and-role projection, and this page renders it — the client sees who they are
 * working with at the agency, and nothing internal.
 */
export default function PortalPeoplePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PortalPeopleScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
