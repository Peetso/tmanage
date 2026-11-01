'use client';

import { use } from 'react';
import { PortalChatScreen } from '../../../../components/screens/PortalChatScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** R7 slice 3 — the portal's Chat tab: the client's groups, no chat open. */
export default function PortalChatPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  return (
    <PortalChatScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
