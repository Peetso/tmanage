'use client';

import { use } from 'react';
import { SettingsHomeScreen } from '../../../components/screens/SettingsHomeScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Settings home (55-22)** at `/{orgSlug}/settings`: grouped cards linking every settings screen,
 * the getting-started checklist, and the owner's Setup health. Organization policy moved to
 * `/{orgSlug}/settings/organization`. The organization name is still a fixture, the reason every
 * sibling settings screen gives: no endpoint returns the current organization's profile by slug.
 */
export default function SettingsHomePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <SettingsHomeScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
