'use client';

import { use } from 'react';
import { ClientInboxScreen } from '../../../../components/screens/ClientInboxScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * The client's inbox — INBOX-001's second half.
 *
 * Not a screen `22-SCREEN-BY-SCREEN` §6 or `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §9 gives an
 * ID to; `CL-08 Updates` is a feed of published status updates, which this is not. See the
 * note on `ClientInboxScreen` — the rail was deliberately left alone, and the page is reached
 * from `CL-01 Overview`.
 */
export default function ClientInboxPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ClientInboxScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
