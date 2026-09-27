'use client';

import { use } from 'react';
import { TeamsScreen } from '../../../../components/screens/TeamsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **People teams** (x262), under People — 38-MODULE-MAP §People "Directory, teams, profile"; planning
 * PEO-03 "Team detail". A sub-route of People rather than the People page itself: the directory is
 * the read surface every member reaches by default, and teams is its own read/admin surface. Keeping
 * it on its own path keeps the two apart while both live under the same destination on the rail.
 */
export default function TeamsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return <TeamsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
