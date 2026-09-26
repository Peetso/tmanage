'use client';

import { use } from 'react';
import { NotificationsFeedScreen } from '../../../components/screens/NotificationsFeedScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Notifications feed (x151).**
 *
 * The flat per-notification feed beside the bundled inbox (`/inbox`): everything the caller has
 * been told, newest first, unread above read, with a "Mark read" on each unread row. The rail
 * item is the inbox's — `CLIENT_NAVIGATION`/`INTERNAL_NAVIGATION` are not touched, the reason
 * `CalendarAgendaPage` gives for reusing the calendar rail item — so this page reuses the inbox
 * navigation id and is reached from the inbox.
 *
 * The organization name is still a fixture, for `InboxPage`'s reason: no endpoint returns the
 * current organization's profile by slug.
 */
export default function NotificationsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <NotificationsFeedScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
