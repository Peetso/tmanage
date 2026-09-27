'use client';

import { use } from 'react';
import { DigestPreferenceScreen } from '../../../../components/screens/DigestPreferenceScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Notification digest frequency (module 20, PREF-DIGEST, x245).**
 *
 * The member's own digest cadence, at `/{orgSlug}/settings/digest`. The organization name is still a
 * fixture, the reason every sibling settings screen gives: no endpoint returns the current
 * organization's profile by slug.
 */
export default function DigestPreferencePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <DigestPreferenceScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
