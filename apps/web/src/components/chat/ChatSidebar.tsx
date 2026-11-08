'use client';

import type { ApiClient } from '../../lib/api/client';
import { ChatListPane } from './ChatListPane';
import { ChatWorkspaceTabs } from './ChatWorkspaceTabs';
import { chatHref, newGroupHref } from './chat-workspaces';

export interface ChatSidebarProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly organizationName: string;
  /** The conversation on screen, inked in the list. */
  readonly activeConversationId?: string;
  /** Pre-R7: a direct conversation is a conversation now, so this is the same id. */
  readonly activeDirectConversationId?: string;
  /**
   * R38 G2: the app's own workspace when `organizationSlug` is another one the person opened
   * from the chat page's workspace tabs. Links stay inside this workspace's app.
   */
  readonly shellOrganizationSlug?: string;
}

/**
 * R7 slice 2: the old channel + DM column is retired; this name now renders the one chat list
 * (`ChatListPane`) so `ProjectChannelScreen`'s context rail shows it until slice 4 moves the pane
 * under `ChatShell` and drops this import (then delete this file). No socket of its own: the
 * screen beside it already follows the open conversation.
 */
export function ChatSidebar({
  api,
  organizationSlug,
  organizationName,
  activeConversationId,
  activeDirectConversationId,
  shellOrganizationSlug,
}: ChatSidebarProps) {
  const shell = shellOrganizationSlug ?? organizationSlug;
  const active = activeConversationId ?? activeDirectConversationId;
  return (
    <ChatListPane
      api={api}
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      listUrlBase={`/${shell}/chat`}
      live={false}
      rowHref={(id) => chatHref(shell, organizationSlug, id)}
      newGroupHref={newGroupHref(shell, organizationSlug)}
      header={<ChatWorkspaceTabs api={api} shellSlug={shell} activeSlug={organizationSlug} />}
      {...(active === undefined ? {} : { activeConversationId: active })}
    />
  );
}
