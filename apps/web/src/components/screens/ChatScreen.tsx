'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { createConversation, listConversations } from '../../lib/api/conversations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ChatScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **TM-06's front door: the channel list.**
 *
 * `22-SCREEN-BY-SCREEN` §4 describes the channel screen itself; this list is how a person
 * reaches one. Every conversation in this system is a **project channel** — CHAT-001 built no
 * other kind — so the list groups by project and the create form asks for a project first.
 *
 * TM-07 (direct and group messages) has no API at all: `conversations.project_id` is not
 * nullable and no ticket has changed that. The absence is stated in `BackendPending` rather
 * than drawn as an empty "Direct messages" section, for the reason every screen in this
 * folder gives.
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

  const rows = conversations.data ?? [];

  return (
    <AppShell
      organizationName={organizationName}
      activeNavigationId="chat"
      title="Chat"
      description="Project channels. Everything said in one stays with its project."
    >
      <BackendPending ticket="TM-07 — unscheduled beyond WEB-003">
        Direct and group messages are not built, and not because this screen is early: every
        conversation the API can hold belongs to a project. A message model without a project has no
        table behind it yet.
      </BackendPending>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-chat-filters">
        <h2 id="tm-chat-filters" className="tm-eyebrow">
          Filters
        </h2>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-chat-project">
            Project
          </label>
          <select
            id="tm-chat-project"
            className="tm-field__control"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">All projects</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <label className="tm-choice tm-choice--inline">
          <input
            className="tm-choice__input"
            type="checkbox"
            checked={includeArchived}
            onChange={() => setIncludeArchived((current) => !current)}
          />
          <span className="tm-choice__name">Show archived channels</span>
        </label>
      </section>

      {conversations.isError ? (
        <InlineAlert tone="danger" title="Could not load the channels" live>
          {conversations.error instanceof ApiRequestError
            ? conversations.error.message
            : conversations.error instanceof NetworkError
              ? 'The API did not answer. Is it running?'
              : 'Something went wrong. Try again.'}
        </InlineAlert>
      ) : null}

      {conversations.isPending ? (
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading the channels.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {!conversations.isPending && !conversations.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No channels yet">
          Create one below. A channel belongs to a project, so pick the project the conversation is
          about.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-list tm-stack">
          {rows.map((conversation) => (
            <li key={conversation.id} className="tm-panel tm-row">
              <div className="tm-stack tm-stack--tight">
                <Link href={`/${organizationSlug}/chat/${conversation.id}`}>
                  #{conversation.name}
                </Link>
                <span className="tm-field__hint">
                  {projectNames.get(conversation.projectId) ?? 'Another project'}
                </span>
              </div>
              {conversation.archivedAt !== null ? (
                <span className="tm-push-end">
                  <Badge mono>Archived</Badge>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-chat-create">
        <h2 id="tm-chat-create" className="tm-eyebrow">
          New channel
        </h2>
        <form className="tm-stack" onSubmit={submitCreate}>
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
              required
            />
            <span className="tm-field__hint">
              A leading # is fine; the API treats #general and general as the same channel.
            </span>
          </div>

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not create the channel" live>
              {create.error instanceof ApiRequestError
                ? create.error.message
                : 'The API did not answer. Try again.'}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
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
          </div>
        </form>
      </section>
    </AppShell>
  );
}
