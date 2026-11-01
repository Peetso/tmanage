'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ChatSidebar } from '../chat/ChatSidebar';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { createConversation, listChannelDirectory } from '../../lib/api/conversations';
import type { ChannelDirectoryEntry } from '../../lib/api/conversations';
import { listConversationUnread } from '../../lib/api/conversation-read-state';
import {
  CHANNEL_FILTERS,
  countByFilter,
  formatLastActivity,
  initialsOf,
  matchesFilter,
  type ChannelFilter,
} from '../chat/channel-browser';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/chat.css';

export interface ChatScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **TM-06's front door: the channel list**, painted as the handoff's CH-01 channel browser.
 *
 * One read — `GET …/conversations/directory` — answers every chip: every channel the viewer may
 * reach (archived included), with its members, how many of them are clients and its last
 * activity, newest first. "My channels" is the viewer's own memberships, "Client shared" is a
 * channel with a client member in it, and the audience column says the same thing in words.
 *
 * Every conversation is a **project channel** (CHAT-001), so the row names its project beside
 * the channel name — channel names are unique per project only, and two `#general` rows would
 * otherwise be indistinguishable. CH-01's private "Request access" and open "Join" rows have no
 * data behind them yet: the API lists only channels the viewer can already open.
 */
export function ChatScreen({ organizationSlug, organizationName, client }: ChatScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const queries = useQueryClient();

  const [filter, setFilter] = useState<ChannelFilter>('all');
  const [newName, setNewName] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [search, setSearch] = useState('');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const directory = useQuery({
    queryKey: ['conversations', organizationSlug, 'directory'],
    queryFn: () => listChannelDirectory(api, organizationSlug),
  });

  // The unread pill is a nicety: a failed read leaves the rows as they are.
  const unread = useQuery({
    queryKey: ['conversations', organizationSlug, 'unread'],
    queryFn: () => listConversationUnread(api, organizationSlug),
  });

  const create = useMutation({
    mutationFn: () =>
      createConversation(api, organizationSlug, { projectId: newProjectId, name: newName }),
    onSuccess: () => {
      setNewName('');
      void queries.invalidateQueries({ queryKey: ['conversations', organizationSlug] });
    },
  });

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);

  const unreadById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of unread.data ?? []) counts.set(entry.conversationId, entry.unreadCount);
    return counts;
  }, [unread.data]);

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (newProjectId === '' || newName.trim() === '') return;
    create.mutate();
  }

  const allRows = directory.data ?? [];
  const counts = countByFilter(allRows);
  const inFilter = allRows.filter((entry) => matchesFilter(entry, filter));
  // The search narrows what the API already answered; it asks the server nothing new.
  const needle = search.trim().replace(/^#/u, '').toLowerCase();
  const rows =
    needle === ''
      ? inFilter
      : inFilter.filter((conversation) => conversation.name.toLowerCase().includes(needle));
  const now = Date.now();

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      contextRail={
        // A4: the Slack-like two-pane layout — the chat column beside the channel browser.
        <ChatSidebar
          api={api}
          organizationSlug={organizationSlug}
          organizationName={organizationName}
        />
      }
      eyebrow={t('ChatScreen.eyebrow')}
      title={t('ChatScreen.title')}
      actions={
        <>
          <label className="tm-chat-browse__search">
            <span aria-hidden="true" className="tm-chat-mono">
              ⌕
            </span>
            <span className="tm-visually-hidden">{t('ChatScreen.searchLabel')}</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={
                allRows.length > 0
                  ? `${t('ChatScreen.searchPrefix')}${allRows.length}${t('ChatScreen.searchChannelsSuffix')}`
                  : t('ChatScreen.searchPlaceholder')
              }
            />
          </label>
          <a className="tm-chat-new" href="#tm-chat-create">
            <span className="tm-chat-new__orb" aria-hidden="true">
              +
            </span>
            <span className="tm-chat-new__label">{t('ChatScreen.newChannel')}</span>
          </a>
        </>
      }
    >
      <div className="tm-chat-browse tm-stack">
        <div
          className="tm-chat-browse__filters"
          role="group"
          aria-label={t('ChatScreen.filterChannels')}
        >
          {CHANNEL_FILTERS.map(({ id, label, labelKey }) => (
            <button
              key={id}
              type="button"
              className={`tm-chat-filter${id === 'client' ? ' tm-chat-filter--client' : ''}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {tOr(labelKey, label)}
              {directory.data ? ` · ${counts[id]}` : ''}
            </button>
          ))}
          <span className="tm-chat-browse__sort">{t('ChatScreen.sortMostActive')}</span>
        </div>

        {directory.isError ? (
          <InlineAlert tone="danger" title={t('ChatScreen.loadError')} live>
            {directory.error instanceof ApiRequestError
              ? directory.error.message
              : directory.error instanceof NetworkError
                ? t('ChatScreen.apiNoAnswer')
                : t('ChatScreen.genericError')}
          </InlineAlert>
        ) : null}

        <section className="tm-chat-table" aria-labelledby="tm-chat-list">
          <h2 id="tm-chat-list" className="tm-visually-hidden">
            {t('ChatScreen.channelsHeading')}
          </h2>
          <div className="tm-chat-table__head" aria-hidden="true">
            <span className="tm-chat-eyebrow">{t('ChatScreen.colChannel')}</span>
            <span className="tm-chat-eyebrow">{t('ChatScreen.colMembers')}</span>
            <span className="tm-chat-eyebrow">{t('ChatScreen.colAudience')}</span>
            <span className="tm-chat-eyebrow">{t('ChatScreen.colLastActivity')}</span>
          </div>

          {directory.isPending ? (
            <LoadingRegion label={t('ChatScreen.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!directory.isPending && !directory.isError && allRows.length === 0 ? (
            <p className="tm-chat-table__empty">
              <strong>{t('ChatScreen.emptyStrong')}</strong>
              {t('ChatScreen.emptyRest')}
            </p>
          ) : null}

          {allRows.length > 0 && rows.length === 0 ? (
            <p className="tm-chat-table__empty">
              {needle === ''
                ? t('ChatScreen.noChannelInView')
                : `No channel name contains “${search.trim()}”.`}
            </p>
          ) : null}

          {rows.length > 0 ? (
            <ul className="tm-chat-table__list">
              {rows.map((conversation) => (
                <ChannelRow
                  key={conversation.id}
                  organizationSlug={organizationSlug}
                  entry={conversation}
                  projectName={
                    conversation.projectId === null
                      ? null
                      : (projectNames.get(conversation.projectId) ?? null)
                  }
                  unreadCount={unreadById.get(conversation.id) ?? 0}
                  now={now}
                />
              ))}
            </ul>
          ) : null}
        </section>

        <section id="tm-chat-create" className="tm-chat-create" aria-labelledby="tm-chat-create-h">
          <h2 id="tm-chat-create-h" className="tm-chat-eyebrow">
            {t('ChatScreen.newChannel')}
          </h2>
          <form className="tm-stack" onSubmit={submitCreate}>
            {/*
              The same gate as the filters, for the same reason: a channel name typed into this
              server-rendered input before React hydrated was held by the DOM, never by `newName`,
              and hydration re-applied `value=''` and erased it. The button already refuses an
              empty name, so the person was told nothing and lost what they wrote.
            */}
            <fieldset className="tm-chat-create__fields" disabled={projects.isPending}>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-chat-new-project">
                  {t('ChatScreen.projectLabel')}
                </label>
                <select
                  id="tm-chat-new-project"
                  className="tm-field__control"
                  value={newProjectId}
                  onChange={(event) => setNewProjectId(event.target.value)}
                  required
                >
                  <option value="">{t('ChatScreen.chooseProject')}</option>
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-chat-new-name">
                  {t('ChatScreen.channelNameLabel')}
                </label>
                <input
                  id="tm-chat-new-name"
                  className="tm-field__control"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  maxLength={120}
                  placeholder={tOr('ChatScreen.channelNamePlaceholder', '#general')}
                  required
                />
              </div>
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel={t('ChatScreen.creating')}
                disabled={newProjectId === '' || newName.trim() === ''}
              >
                {t('ChatScreen.createChannel')}
              </Button>
            </fieldset>

            {create.isError ? (
              <InlineAlert tone="danger" title={t('ChatScreen.createError')} live>
                {create.error instanceof ApiRequestError
                  ? create.error.message
                  : t('ChatScreen.apiNoAnswerRetry')}
              </InlineAlert>
            ) : null}
          </form>
        </section>
      </div>
    </AppShell>
  );
}

interface ChannelRowProps {
  organizationSlug: string;
  entry: ChannelDirectoryEntry;
  projectName: string | null;
  unreadCount: number;
  now: number;
}

/** One CH-01 row: name and tags, member avatars, audience, last activity. */
function ChannelRow({ organizationSlug, entry, projectName, unreadCount, now }: ChannelRowProps) {
  const t = useT();
  const tOr = useTOr();
  const archived = entry.archivedAt !== null;
  const internalCount = entry.memberCount - entry.clientMemberCount;
  const clientShared = entry.clientMemberCount > 0;

  return (
    <li className="tm-chat-table__row" {...(archived ? { 'data-archived': 'true' } : {})}>
      <span className="tm-chat-table__name">
        <Link href={`/${organizationSlug}/chat/${entry.id}`}>#{entry.name}</Link>
        {entry.joined && !archived ? (
          <span className="tm-chat-joined">{t('ChatScreen.joined')}</span>
        ) : null}
        {unreadCount > 0 && !archived ? (
          <span
            className="tm-chat-unread"
            role="img"
            aria-label={`${unreadCount} ${
              unreadCount === 1
                ? tOr('ChatSidebar.unreadOne', 'unread message')
                : tOr('ChatSidebar.unreadMany', 'unread messages')
            }`}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
        {projectName ? <span className="tm-chat-table__project">{projectName}</span> : null}
      </span>
      <span className="tm-chat-table__members">
        {entry.memberPreview.length > 0 && !archived ? (
          <span className="tm-chat-avatars" aria-hidden="true">
            {entry.memberPreview.map((member) => (
              <span
                key={member.userId}
                className={`tm-chat-avatar${member.isClient ? ' tm-chat-avatar--client' : ''}`}
                title={member.displayName}
              >
                {initialsOf(member.displayName)}
              </span>
            ))}
          </span>
        ) : null}
        <span
          className="tm-chat-table__count"
          role="img"
          aria-label={
            clientShared
              ? tOr('ChatScreen.teamAndClientMembers', '{team} team and {client} client members')
                  .replace('{team}', String(internalCount))
                  .replace('{client}', String(entry.clientMemberCount))
              : `${entry.memberCount} ${
                  entry.memberCount === 1
                    ? tOr('ChatScreen.memberOne', 'member')
                    : tOr('ChatScreen.memberMany', 'members')
                }`
          }
        >
          {clientShared ? `${internalCount} + ${entry.clientMemberCount}` : entry.memberCount}
        </span>
      </span>
      <span className="tm-chat-table__audience">
        {archived ? (
          <span className="tm-chat-tag">{t('ChatScreen.archived')}</span>
        ) : (
          <span
            className={`tm-chat-audience tm-chat-audience--compact${
              clientShared ? ' tm-chat-audience--client' : ''
            }`}
          >
            <span className="tm-chat-audience__orb" aria-hidden="true">
              {clientShared ? '◎' : '■'}
            </span>
            {clientShared ? t('ChatScreen.clientVisible') : t('ChatScreen.internal')}
          </span>
        )}
      </span>
      <span className="tm-chat-table__state">
        <time className="tm-chat-mono" dateTime={entry.lastActivityAt}>
          {formatLastActivity(entry.lastActivityAt, now)}
        </time>
      </span>
    </li>
  );
}
