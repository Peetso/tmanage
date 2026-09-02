'use client';

import { use } from 'react';
import { InboxScreen } from '../../../components/screens/InboxScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **TM-04 Inbox** — the second destination on the internal rail (`22-SCREEN-BY-SCREEN` §1).
 *
 * The rail's own href is the org-less `/inbox` that `navigation.ts` has carried since WEB-001;
 * this route is the org-scoped page that href is meant to reach. Fixing the rail hrefs is a
 * change to every rail item at once and is recorded rather than done here.
 *
 * The organization name is still a fixture, for the reason `TM-10` gives: no endpoint returns
 * the current organization's profile by slug.
 */
export default function InboxPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return <InboxScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
