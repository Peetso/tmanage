'use client';

import { Suspense, use } from 'react';
import { AppShell } from '../../../components/shell/AppShell';
import { ChatShell } from '../../../components/chat/ChatShell';
import { NewChannelForm } from '../../../components/chat/NewChannelForm';
import { browserApiClient } from '../../../lib/api/browser-client';
import { NewGroupLauncher } from '../../../components/chat/NewGroupDialog';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';
import { useTOr } from '../../../lib/i18n/use-t-or';

/**
 * **Chats** (R7 F1) — the rail's Chat destination: the one list of channels, groups and direct
 * messages beside an empty pane (desktop), or the list alone (phone).
 */
export default function ChatPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const tOr = useTOr();
  const api = browserApiClient();

  return (
    <AppShell
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="chat"
      title={tOr('ChatList.title', 'Chats')}
    >
      <ChatShell
        door="studio"
        listUrlBase={`/${orgSlug}/chat`}
        organizationName={FIXTURE_ORGANIZATION_NAME}
        api={api}
        empty={<NewChannelForm api={api} organizationSlug={orgSlug} />}
      />
      {/* R7 slice 3: "New group" on the list links to ?new=group. */}
      <Suspense fallback={null}>
        <NewGroupLauncher organizationSlug={orgSlug} />
      </Suspense>
    </AppShell>
  );
}
