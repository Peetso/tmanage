'use client';

import { use } from 'react';
import { AccessibilityScreen } from '../../../../components/screens/AccessibilityScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Accessibility preferences (module 20, A11Y, x183).**
 *
 * The member's own font-size / reduced-motion / high-contrast controls, at
 * `/{orgSlug}/settings/accessibility`. The organization name is still a fixture, the reason every
 * sibling screen gives: no endpoint returns the current organization's profile by slug.
 */
export default function AccessibilityPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <AccessibilityScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
