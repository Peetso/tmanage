'use client';

import { use } from 'react';
import { OffboardingScreen } from '../../../../components/screens/OffboardingScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **ADM-12 / ADM-13 — member offboarding** (x121), under People.
 *
 * A sub-route of People rather than the People page itself: the directory is the read surface every
 * member uses, and this is the Administration write boundary that revokes access, guarded by
 * `member.offboard`. Keeping it on its own path keeps the two apart while both live under the same
 * destination on the rail.
 */
export default function OffboardingPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <OffboardingScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
