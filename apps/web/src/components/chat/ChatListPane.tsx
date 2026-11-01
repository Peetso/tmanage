'use client';

import { useContext, useMemo, useState } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { chatKeys, chatRowMatches, fetchChatList, setChatMark } from '../../lib/api/chat';
import type { ChatListRowData, ChatMark } from '../../lib/api/chat';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useChannelLiveFeed } from '../../lib/use-channel-live-feed';
import type { LiveSocketFactory } from '../../lib/use-channel-live-feed';
import { ChatListRow } from './ChatListRow';
import { ChatListSearch } from './ChatListSearch';
import { NewChatSheet } from './NewChatSheet';
import './chat-shell.css';

export interface ChatListPaneProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly organizationName: string;
  /** Where a row links: `${listUrlBase}/${conversationId}`. */
  readonly listUrlBase: string;
  readonly activeConversationId?: string;
  /**
   * Follow the active conversation's `message.created.v1` frames and refetch the list on each.
   * Off where the screen beside the list already holds that conversation's socket.
   */
  readonly live?: boolean;
  readonly socketFactory?: LiveSocketFactory;
  /** `portal` reads the client's groups from `…/portal/chat/list` (slice 3's route). */
  readonly door?: 'studio' | 'portal';
  /** "New chat" (people → direct conversation, New group). Off for the portal. */
  readonly allowNewChat?: boolean;
}

/** How often the list re-reads without a frame: other chats' news arrives at this pace. */
const LIST_REFRESH_MS = 20_000;

/**
 * R7 F1 — the left pane: every chat the viewer is in (channels, groups, direct conversations),
 * pinned first, then by last message; search; an "Archived" folder; pin / archive per row.
 *
 * One socket at most (the member cap is five): the active conversation's, so the open chat's own
 * news moves its row at once; the rest of the list refreshes every {@link LIST_REFRESH_MS}.
 */
export function ChatListPane({
  api,
  organizationSlug,
  organizationName,
  listUrlBase,
  activeConversationId,
  live = true,
  socketFactory,
  door = 'studio',
  allowNewChat = true,
}: ChatListPaneProps) {
  const tOr = useTOr();
  const router = useContext(AppRouterContext);
  const queries = useQueryClient();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [composing, setComposing] = useState(false);

  const list = useQuery({
    queryKey: [...chatKeys.list(organizationSlug, showArchived), door],
    queryFn: () => fetchChatList(api, organizationSlug, { includeArchived: showArchived, door }),
    refetchInterval: LIST_REFRESH_MS,
  });

  useChannelLiveFeed({
    api,
    organizationSlug,
    conversationId: activeConversationId ?? '',
    enabled: live && activeConversationId !== undefined,
    onCatchUp: () => void queries.invalidateQueries({ queryKey: chatKeys.all(organizationSlug) }),
    ...(socketFactory ? { socketFactory } : {}),
  });

  const mark = useMutation({
    mutationFn: (input: { row: ChatListRowData; mark: ChatMark; on: boolean }) =>
      setChatMark(api, organizationSlug, input.row.conversationId, input.mark, input.on),
    onSettled: () => void queries.invalidateQueries({ queryKey: chatKeys.all(organizationSlug) }),
  });

  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const shown = rows
    .filter((row) => (showArchived ? row.archivedAt !== null : row.archivedAt === null))
    .filter((row) => chatRowMatches(row, search));

  function go(href: string) {
    if (router) router.push(href);
    else window.location.assign(href);
  }

  const emptyText =
    search.trim() !== ''
      ? tOr('ChatList.noMatch', 'No chats match your search')
      : showArchived
        ? tOr('ChatList.noArchived', 'No archived chats')
        : tOr('ChatList.empty', 'No chats yet. Start one with New chat.');

  return (
    <div className="tm-chat-side tm-chatlist">
      <div className="tm-chatlist__head">
        <h2 className="tm-chatlist__title">
          {showArchived
            ? tOr('ChatList.archivedTitle', 'Archived')
            : tOr('ChatList.title', 'Chats')}
        </h2>
        {allowNewChat ? (
          <button
            type="button"
            className="tm-chatlist__new"
            onClick={() => setComposing(true)}
            aria-label={tOr('ChatList.newChat', 'New chat')}
            title={tOr('ChatList.newChat', 'New chat')}
          >
            <span aria-hidden="true">+</span>
          </button>
        ) : null}
      </div>
      <ChatListSearch value={search} onChange={setSearch} />
      <button
        type="button"
        className="tm-chatlist__folder"
        aria-pressed={showArchived}
        onClick={() => setShowArchived((value) => !value)}
      >
        <span aria-hidden="true">{showArchived ? '‹' : '🗄'}</span>{' '}
        {showArchived
          ? tOr('ChatList.backToChats', 'Back to chats')
          : tOr('ChatList.archivedFolder', 'Archived')}
      </button>
      {list.isError ? (
        <p className="tm-chatlist__note" role="status">
          {tOr('ChatList.loadError', 'Could not load your chats. Try again.')}
        </p>
      ) : list.isPending ? (
        <p className="tm-chatlist__note" role="status">
          {tOr('ChatList.loading', 'Loading chats…')}
        </p>
      ) : shown.length === 0 ? (
        <p className="tm-chatlist__note tm-chatlist__empty">{emptyText}</p>
      ) : (
        <ul className="tm-chatlist__rows" aria-label={tOr('ChatList.title', 'Chats')}>
          {shown.map((row) => (
            <ChatListRow
              key={row.conversationId}
              row={row}
              href={`${listUrlBase}/${row.conversationId}`}
              active={row.conversationId === activeConversationId}
              {...(door === 'studio'
                ? {
                    onTogglePin: (r: ChatListRowData) =>
                      mark.mutate({ row: r, mark: 'pin', on: r.pinnedAt === null }),
                    onToggleArchive: (r: ChatListRowData) =>
                      mark.mutate({ row: r, mark: 'archive', on: r.archivedAt === null }),
                  }
                : {})}
            />
          ))}
        </ul>
      )}
      {composing ? (
        <NewChatSheet
          api={api}
          organizationSlug={organizationSlug}
          organizationName={organizationName}
          onClose={() => setComposing(false)}
          onOpened={(conversationId) => {
            setComposing(false);
            void queries.invalidateQueries({ queryKey: chatKeys.all(organizationSlug) });
            go(`${listUrlBase}/${conversationId}`);
          }}
        />
      ) : null}
    </div>
  );
}
