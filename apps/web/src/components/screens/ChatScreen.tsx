'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { createConversation, listConversations } from '../../lib/api/conversations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/chat.css';

export interface ChatScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **TM-06's front door: the channel list**, painted as the handoff's CH-01 channel browser.
 *
 * `22-SCREEN-BY-SCREEN` §4 describes the channel screen itself; this list is how a person
 * reaches one. Every conversation in this system is a **project channel** — CHAT-001 built no
 * other kind — so the list groups by project and the create form asks for a project first.
 *
 * TM-07 (direct and group messages) has no API at all: `conversations.project_id` is not
 * nullable and no ticket has changed that, so the browser lists project channels only and draws
 * no empty "Direct" section. A conversation has no audience column either, so every row says
 * "Internal" — the only audience the data can hold.
 *
 * Archived channels are listed on request rather than hidden forever: archival keeps the
 * name taken and the transcript readable, and a list that could never show them again would
 * make the archive a hole rather than a state.
 */
export function ChatScreen({ organizationSlug, organizationName, client }: ChatScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [projectId, setProjectId] = useState<string>('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [search, setSearch] = useState('');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const conversations = useQuery({
    queryKey: ['conversations', organizationSlug, projectId, includeArchived],
    queryFn: () =>
      listConversations(api, organizationSlug, {
        ...(projectId === '' ? {} : { projectId }),
        ...(includeArchived ? { includeArchived: true } : {}),
      }),
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

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (newProjectId === '' || newName.trim() === '') return;
    create.mutate();
  }

  const allRows = conversations.data ?? [];
  // The search narrows what the API already answered; it asks the server nothing new.
  const needle = search.trim().replace(/^#/u, '').toLowerCase();
  const rows =
    needle === ''
      ? allRows
      : allRows.filter((conversation) => conversation.name.toLowerCase().includes(needle));

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      eyebrow="Chat"
      title="Channels"
      actions={
        <>
          <label className="tm-chat-browse__search">
            <span aria-hidden="true" className="tm-chat-mono">
              ⌕
            </span>
            <span className="tm-visually-hidden">Search channels</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={
                allRows.length > 0 ? `Search ${allRows.length} channels` : 'Search channels'
              }
            />
          </label>
          <a className="tm-chat-new" href="#tm-chat-create">
            <span className="tm-chat-new__orb" aria-hidden="true">
              +
            </span>
            <span className="tm-chat-new__label">New channel</span>
          </a>
        </>
      }
    >
      <div className="tm-chat-browse tm-stack">
        {/*
          Inert until the projects query has answered. Both controls are controlled inputs
          rendered in the server HTML, so without this a filter chosen before React hydrated
          would be re-applied from state — `''` and `false` — and silently undone. `isError`
          means `isPending === false`, so a failed project list still leaves the filters usable.
        */}
        <fieldset className="tm-chat-browse__filters" disabled={projects.isPending}>
          <legend className="tm-visually-hidden">Filters</legend>
          <label htmlFor="tm-chat-project" className="tm-visually-hidden">
            Project
          </label>
          <select
            id="tm-chat-project"
            className={`tm-chat-select${projectId === '' ? '' : ' tm-chat-select--quiet'}`}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">
              {conversations.data && projectId === ''
                ? `All projects · ${allRows.length}`
                : 'All projects'}
            </option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>

          <label className="tm-chat-toggle">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={() => setIncludeArchived((current) => !current)}
            />
            <span>Show archived channels</span>
          </label>

          <span className="tm-chat-browse__sort">Sort · Newest first</span>
        </fieldset>

        {conversations.isError ? (
          <InlineAlert tone="danger" title="Could not load the channels" live>
            {conversations.error instanceof ApiRequestError
              ? conversations.error.message
              : conversations.error instanceof NetworkError
                ? 'The API did not answer. Is it running?'
                : 'Something went wrong. Try again.'}
          </InlineAlert>
        ) : null}

        <section className="tm-chat-table" aria-labelledby="tm-chat-list">
          <h2 id="tm-chat-list" className="tm-visually-hidden">
            Channels
          </h2>
          <div className="tm-chat-table__head" aria-hidden="true">
            <span className="tm-chat-eyebrow">Channel</span>
            <span className="tm-chat-eyebrow">Project</span>
            <span className="tm-chat-eyebrow">Audience</span>
            <span className="tm-chat-eyebrow">Created</span>
          </div>

          {conversations.isPending ? (
            <LoadingRegion label="Loading the channels.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!conversations.isPending && !conversations.isError && allRows.length === 0 ? (
            <p className="tm-chat-table__empty">
              <strong>No channels yet.</strong> Create one below. A channel belongs to a project, so
              pick the project the conversation is about.
            </p>
          ) : null}

          {allRows.length > 0 && rows.length === 0 ? (
            <p className="tm-chat-table__empty">No channel name contains “{search.trim()}”.</p>
          ) : null}

          {rows.length > 0 ? (
            <ul className="tm-chat-table__list">
              {rows.map((conversation) => {
                const archived = conversation.archivedAt !== null;
                return (
                  <li
                    key={conversation.id}
                    className="tm-chat-table__row"
                    {...(archived ? { 'data-archived': 'true' } : {})}
                  >
                    <span className="tm-chat-table__name">
                      <Link href={`/${organizationSlug}/chat/${conversation.id}`}>
                        #{conversation.name}
                      </Link>
                    </span>
                    <span className="tm-chat-table__project">
                      {projectNames.get(conversation.projectId) ?? 'Another project'}
                    </span>
                    <span className="tm-chat-table__audience">
                      <span className="tm-chat-audience tm-chat-audience--compact">
                        <span className="tm-chat-audience__orb" aria-hidden="true">
                          ■
                        </span>
                        Internal
                      </span>
                    </span>
                    <span className="tm-chat-table__state">
                      {archived ? (
                        <span className="tm-chat-tag">Archived</span>
                      ) : (
                        <time className="tm-chat-mono" dateTime={conversation.createdAt}>
                          {formatDay(conversation.createdAt)}
                        </time>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <section id="tm-chat-create" className="tm-chat-create" aria-labelledby="tm-chat-create-h">
          <h2 id="tm-chat-create-h" className="tm-chat-eyebrow">
            New channel
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
                  Project
                </label>
                <select
                  id="tm-chat-new-project"
                  className="tm-field__control"
                  value={newProjectId}
                  onChange={(event) => setNewProjectId(event.target.value)}
                  required
                >
                  <option value="">Choose a project</option>
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-chat-new-name">
                  Channel name
                </label>
                <input
                  id="tm-chat-new-name"
                  className="tm-field__control"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  maxLength={120}
                  placeholder="#general"
                  required
                />
              </div>
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel="Creating"
                disabled={newProjectId === '' || newName.trim() === ''}
              >
                Create channel
              </Button>
            </fieldset>

            {create.isError ? (
              <InlineAlert tone="danger" title="Could not create the channel" live>
                {create.error instanceof ApiRequestError
                  ? create.error.message
                  : 'The API did not answer. Try again.'}
              </InlineAlert>
            ) : null}
          </form>
        </section>
      </div>
    </AppShell>
  );
}

function formatDay(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(parsed);
}
