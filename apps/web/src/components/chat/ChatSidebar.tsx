'use client';

import { useContext, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { listChannelDirectory } from '../../lib/api/conversations';
import { directKeys, listDirectConversations } from '../../lib/api/direct-conversations';
import type { DirectConversationSummary } from '../../lib/api/direct-conversations';
import { listProjects } from '../../lib/api/projects';
import { useTOr } from '../../lib/i18n/use-t-or';
import { initialsOf } from './channel-browser';
import { NewMessageDialog } from './NewMessageDialog';
import './chat-shell.css';

export interface ChatSidebarProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly organizationName: string;
  /** The channel on screen, inked in the list. */
  readonly activeConversationId?: string;
  /** The direct conversation on screen, inked in the list. */
  readonly activeDirectConversationId?: string;
}

/**
 * The Slack-like chat column (d-conversation / m-mention): a find field, PROJECT CHANNELS — the
 * channels this person is in — and DIRECT MESSAGES with a "+" that opens New message. A DM row is
 * the initials orb, the name and either the unread pill or nothing; a client gets the violet ring
 * and the "Client" chip. Every list is a read the API already authorizes: the channel directory
 * (`…/conversations/directory`) and the caller's own direct conversations.
 *
 * A channel link's accessible name carries its project as well as `#name`, because channel names
 * are unique per project only — two `#general` rows must be told apart by a screen reader too.
 */
export function ChatSidebar({
  api,
  organizationSlug,
  organizationName,
  activeConversationId,
  activeDirectConversationId,
}: ChatSidebarProps) {
  const tOr = useTOr();
  const router = useContext(AppRouterContext);
  const [find, setFind] = useState('');
  const [composing, setComposing] = useState(false);

  const directory = useQuery({
    queryKey: ['conversations', organizationSlug, 'directory'],
    queryFn: () => listChannelDirectory(api, organizationSlug),
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const direct = useQuery({
    queryKey: directKeys.list(organizationSlug),
    queryFn: () => listDirectConversations(api, organizationSlug),
  });

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of Array.isArray(projects.data) ? projects.data : []) {
      names.set(project.id, project.name);
    }
    return names;
  }, [projects.data]);

  const entries = useMemo(
    () => (Array.isArray(directory.data) ? directory.data : []),
    [directory.data],
  );

  // A client is somebody the channel directory marks as one; the DM list does not say.
  const clientIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      for (const member of entry.memberPreview ?? []) if (member.isClient) ids.add(member.userId);
    }
    return ids;
  }, [entries]);

  const needle = find.trim().replace(/^[#@]/u, '').toLocaleLowerCase();
  const channels = entries
    .filter(
      (entry) => entry.archivedAt === null && (entry.joined || entry.id === activeConversationId),
    )
    .filter((entry) => needle === '' || entry.name.toLocaleLowerCase().includes(needle));
  const people = (Array.isArray(direct.data) ? direct.data : []).filter(
    (row) => needle === '' || displayNameOf(row).toLocaleLowerCase().includes(needle),
  );

  function go(href: string) {
    if (router) router.push(href);
    else window.location.assign(href);
  }

  return (
    <div className="tm-chat-side">
      <label className="tm-chat-side__find">
        <span className="tm-chat-side__find-glyph" aria-hidden="true">
          ⌕
        </span>
        <span className="tm-visually-hidden">
          {tOr('ChatSidebar.findLabel', 'Find a channel or person')}
        </span>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder={tOr('ChatSidebar.findPlaceholder', 'Find a channel or person')}
        />
        <kbd className="tm-chat-side__kbd" aria-hidden="true">
          ⌘K
        </kbd>
      </label>

      <section className="tm-chat-side__group" aria-labelledby="tm-chat-side-channels">
        <h2 id="tm-chat-side-channels" className="tm-chat-side__eyebrow">
          {tOr('ChatSidebar.projectChannels', 'Project channels')}
        </h2>
        <ul className="tm-chat-side__list">
          {channels.map((entry) => {
            const current = entry.id === activeConversationId;
            const project =
              projectNames.get(entry.projectId) ??
              tOr('ChatSidebar.projectChannel', 'Project channel');
            return (
              <li key={entry.id}>
                <Link
                  className="tm-chat-side__row tm-chat-side__row--channel"
                  href={`/${organizationSlug}/chat/${entry.id}`}
                  aria-label={`#${entry.name}, ${project}`}
                  {...(current ? { 'aria-current': 'page' as const } : {})}
                >
                  <bdi dir="ltr">#{entry.name}</bdi>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="tm-chat-side__group" aria-labelledby="tm-chat-side-direct">
        <div className="tm-chat-side__group-head">
          <h2 id="tm-chat-side-direct" className="tm-chat-side__eyebrow">
            {tOr('ChatSidebar.directMessages', 'Direct messages')}
          </h2>
          <button
            type="button"
            className="tm-chat-side__plus"
            aria-label={tOr('ChatSidebar.newMessage', 'New message')}
            title={tOr('ChatSidebar.newMessage', 'New message')}
            onClick={() => setComposing(true)}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
        <ul className="tm-chat-side__list">
          {people.map((row) => {
            const current = row.id === activeDirectConversationId;
            const name = displayNameOf(row);
            const isClient = clientIds.has(row.otherUserId);
            const unread = current ? 0 : row.unreadCount;
            return (
              <li key={row.id}>
                <Link
                  className="tm-chat-side__row tm-chat-side__row--person"
                  href={`/${organizationSlug}/chat/dm/${row.id}`}
                  {...(current ? { 'aria-current': 'page' as const } : {})}
                >
                  <span
                    className={`tm-chat-side__orb${isClient ? ' tm-chat-side__orb--client' : ''}`}
                    aria-hidden="true"
                  >
                    {initialsOf(name)}
                  </span>
                  <span className="tm-chat-side__name">{name}</span>
                  {unread > 0 ? (
                    <span className="tm-chat-side__pill">
                      <span aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                      <span className="tm-visually-hidden">
                        {`, ${unread} ${
                          unread === 1
                            ? tOr('ChatSidebar.unreadOne', 'unread message')
                            : tOr('ChatSidebar.unreadMany', 'unread messages')
                        }`}
                      </span>
                    </span>
                  ) : null}
                  {isClient ? (
                    <span className="tm-chat-side__chip">
                      {tOr('ChatSidebar.client', 'Client')}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {composing ? (
        <NewMessageDialog
          api={api}
          organizationSlug={organizationSlug}
          organizationName={organizationName}
          onClose={() => setComposing(false)}
          onOpened={(conversation) => {
            setComposing(false);
            go(`/${organizationSlug}/chat/dm/${conversation.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function displayNameOf(row: DirectConversationSummary): string {
  return row.otherDisplayName ?? row.otherUserId.slice(0, 8);
}
