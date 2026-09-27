'use client';

import { use } from 'react';
import { FocusBlocksScreen } from '../../../../components/screens/FocusBlocksScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Calendar focus blocks (module Calendar, CAL-04 "Focus block", x255).**
 *
 * A member's own protected time on the calendar, at `/{orgSlug}/calendar/focus-blocks`. The
 * organization name is still a fixture, the reason every sibling screen gives: no endpoint returns the
 * current organization's profile by slug.
 */
export default function FocusBlocksPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <FocusBlocksScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
