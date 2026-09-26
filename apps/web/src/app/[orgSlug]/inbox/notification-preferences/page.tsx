'use client';

import { use } from 'react';
import { NotificationKindPrefs } from '../../../../components/screens/NotificationKindPrefs';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Per-kind notification opt-out (x152)** — the notification-kinds settings page, reached from the
 * Inbox area of the internal rail (module 17 Notifications).
 *
 * A disjoint route from the Inbox feed itself: it owns only the per-kind opt-out region. The
 * organization name is still a fixture, for the reason the sibling pages give: no endpoint returns the
 * current organization's profile by slug.
 */
export default function NotificationKindPrefsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <NotificationKindPrefs
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
