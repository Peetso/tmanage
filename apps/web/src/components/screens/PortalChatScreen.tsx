'use client';

import { ChatShell } from '../chat/ChatShell';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { ProjectChannelScreen } from './ProjectChannelScreen';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';

export interface PortalChatScreenProps {
  readonly organizationSlug: string;
  readonly clientName: string;
  readonly providerName: string;
  /** The open group, when the URL names one. */
  readonly conversationId?: string;
  readonly api?: ApiClient;
}

/**
 * R7 slice 3 — the portal's Chat tab (Figma 493:29357 / 493:29514): the groups this client contact
 * is a member of (`…/portal/chat/list`, groups only — never a project channel or a direct
 * conversation) beside the open group. Messages, attachments and reactions go through the
 * conversation routes, where the client is admitted as a member of that group and nowhere else.
 */
export function PortalChatScreen({
  organizationSlug,
  clientName,
  providerName,
  conversationId,
  api,
}: PortalChatScreenProps) {
  const tOr = useTOr();
  const listUrlBase = `/${organizationSlug}/portal/chat`;
  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="chat"
      title={tOr('PortalChat.title', 'Chat')}
      description={tOr('PortalChat.description', 'Your group chats with {provider}.').replace(
        '{provider}',
        providerName,
      )}
    >
      <ChatShell
        door="portal"
        listUrlBase={listUrlBase}
        organizationName={providerName}
        {...(api ? { api } : {})}
        {...(conversationId === undefined ? {} : { activeConversationId: conversationId })}
      >
        {conversationId === undefined ? null : (
          <ProjectChannelScreen
            organizationSlug={organizationSlug}
            organizationName={providerName}
            conversationId={conversationId}
            door="portal"
            {...(api ? { client: api } : {})}
          />
        )}
      </ChatShell>
    </ClientPortalShell>
  );
}
