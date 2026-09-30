'use client';

import { use } from 'react';
import { StartupLandingView } from '../../../../components/screens/StartupLandingView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Default startup landing view (module 20, PREF-STARTUP, x287).**
 *
 * The member's own choice of which screen the app opens to on sign-in, at
 * `/{orgSlug}/settings/startup`. The organization name is still a fixture, the reason every sibling
 * settings screen gives: no endpoint returns the current organization's profile by slug.
 */
export default function StartupPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <StartupLandingView organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
