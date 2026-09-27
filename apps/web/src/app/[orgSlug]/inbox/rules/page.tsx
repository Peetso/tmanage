'use client';

import { use } from 'react';
import { InboxRulesScreen } from '../../../../components/screens/InboxRulesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Inbox routing rules (x301)** — the inbox-rules settings page, reached from the Inbox area of the
 * internal rail (module Inbox).
 *
 * A disjoint route from the Inbox feed itself and from the notification-kinds page: it owns only the
 * routing-rules region. The organization name is still a fixture, for the reason the sibling pages
 * give: no endpoint returns the current organization's profile by slug.
 */
export default function InboxRulesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <InboxRulesScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
