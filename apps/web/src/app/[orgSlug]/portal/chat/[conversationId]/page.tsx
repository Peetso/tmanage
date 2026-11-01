'use client';

import { use } from 'react';
import { PortalChatScreen } from '../../../../../components/screens/PortalChatScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/** R7 slice 3 — the portal's Chat tab with one of the client's groups open. */
export default function PortalChatConversationPage({
  params,
}: {
  params: Promise<{ orgSlug: string; conversationId: string }>;
}) {
  const { orgSlug, conversationId } = use(params);
  return (
    <PortalChatScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      conversationId={conversationId}
    />
  );
}
