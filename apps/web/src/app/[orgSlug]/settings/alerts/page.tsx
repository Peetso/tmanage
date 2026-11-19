'use client';

import { use } from 'react';
import { AlertSettingsScreen } from '../../../../components/screens/AlertSettingsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Settings → Alerts (62-27, B12).** The owner's signal rules at `/{orgSlug}/settings/alerts`.
 * The organization name is the fixture every sibling settings page passes (the shell reads the
 * real name by slug).
 */
export default function AlertSettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <AlertSettingsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
