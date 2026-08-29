'use client';

import { use } from 'react';
import { ChatScreen } from '../../../components/screens/ChatScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **The channel list** — the way into `TM-06`. The rail's Chat destination.
 */
export default function ChatPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return <ChatScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />;
}
