'use client';

import { Suspense, use } from 'react';
import { AppShell } from '../../../components/shell/AppShell';
import { ChatShell } from '../../../components/chat/ChatShell';
import { NewChannelForm } from '../../../components/chat/NewChannelForm';
import {
  CHAT_WORKSPACE_PARAM,
  chatHref,
  chatWorkspaceFrom,
} from '../../../components/chat/chat-workspaces';
import { browserApiClient } from '../../../lib/api/browser-client';
import { NewGroupLauncher } from '../../../components/chat/NewGroupDialog';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';
import { useTOr } from '../../../lib/i18n/use-t-or';

/**
 * **Chats** (R7 F1) — the rail's Chat destination: the one list of channels, groups and direct
 * messages beside an empty pane (desktop), or the list alone (phone).
 *
 * R38 G2: `?ws=<slug>` shows another workspace's chats (picked from the workspace tabs) while the
 * app frame stays in this one. The API answers those requests under the person's own membership
 * in that workspace; a slug they do not belong to answers no chats.
 */
export default function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = use(params);
  const chatSlug = chatWorkspaceFrom(orgSlug, use(searchParams)[CHAT_WORKSPACE_PARAM]);
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
        {...(chatSlug === undefined ? {} : { workspaceSlug: chatSlug })}
        empty={
          <NewChannelForm
            api={api}
            organizationSlug={chatSlug ?? orgSlug}
            channelHref={(id) => chatHref(orgSlug, chatSlug, id)}
          />
        }
      />
      {/* R7 slice 3: "New group" on the list links to ?new=group. */}
      <Suspense fallback={null}>
        <NewGroupLauncher organizationSlug={orgSlug} />
      </Suspense>
    </AppShell>
  );
}
