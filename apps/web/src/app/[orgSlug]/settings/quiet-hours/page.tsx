'use client';

import { use } from 'react';
import { QuietHoursScreen } from '../../../../components/screens/QuietHoursScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Notification quiet hours (module 20, PREF-QUIET, x215).**
 *
 * The member's own do-not-disturb window, at `/{orgSlug}/settings/quiet-hours`. The organization name
 * is still a fixture, the reason every sibling settings screen gives: no endpoint returns the current
 * organization's profile by slug.
 */
export default function QuietHoursPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <QuietHoursScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
