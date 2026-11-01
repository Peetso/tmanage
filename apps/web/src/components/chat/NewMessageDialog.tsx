'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { listChannelDirectory } from '../../lib/api/conversations';
import {
  directKeys,
  fetchDirectConversations,
  openDirectConversation,
  type DirectConversationSummary,
} from '../../lib/api/direct-conversations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { listProjects } from '../../lib/api/projects';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useMembers } from '../../lib/use-members';
import { useOrganizationName } from '../../lib/use-organization-names';
import { initialsOf } from './channel-browser';
import { memberRoleLabel } from './MentionPicker';
import './chat-shell.css';

export interface NewMessageDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly onClose: () => void;
  readonly onOpened: (conversation: DirectConversationSummary) => void;
}

interface Person {
  readonly userId: string;
  readonly displayName: string;
  readonly subtitle: string;
  readonly isClient: boolean;
}

/**
 * **d-new-message** — "To" search over YOUR TEAM (the member directory, searched on the server)
 * and CLIENTS ON PROJECTS YOU SHARE (client people in the project channels this person can read).
 * "Open conversation" is create-or-get, so picking somebody you already talk to opens that thread.
 * The API applies the relation rule; a refused pair answers 404, which is said as the rule itself.
 */
export function NewMessageDialog({
  api,
  organizationSlug,
  organizationName: passedOrganizationName,
  onClose,
  onOpened,
}: NewMessageDialogProps) {
  // The live workspace name, not the design's sample company the route passes down.
  const organizationName = useOrganizationName(organizationSlug, passedOrganizationName);
  const tOr = useTOr();
  const queries = useQueryClient();
  const titleId = useId();
  const toId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const team = useMembers(api, organizationSlug, query.trim());
  const directory = useQuery({
    queryKey: ['conversations', organizationSlug, 'directory'],
    queryFn: () => listChannelDirectory(api, organizationSlug),
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // C5: the caller is never somebody to start a conversation with, so they are left out.
  const overview = useQuery({
    queryKey: directKeys.overview(organizationSlug),
    queryFn: () => fetchDirectConversations(api, organizationSlug),
  });
  const viewerUserId = overview.data?.viewerUserId ?? null;

  const needle = query.trim().toLocaleLowerCase();

  const teamPeople = useMemo<readonly Person[]>(
    () =>
      (team.members ?? [])
        .filter((member) => !member.role.startsWith('client') && member.userId !== viewerUserId)
        .map((member) => {
          const role = memberRoleLabel(member.role, tOr);
          return {
            userId: member.userId,
            displayName: member.displayName,
            subtitle: [role, organizationName].filter(Boolean).join(' · '),
            isClient: false,
          };
        }),
    [team.members, organizationName, tOr, viewerUserId],
  );

  const clientPeople = useMemo<readonly Person[]>(() => {
    const names = new Map<string, string>();
    for (const project of Array.isArray(projects.data) ? projects.data : []) {
      names.set(project.id, project.name);
    }
    const byId = new Map<string, { displayName: string; projects: Set<string> }>();
    for (const entry of Array.isArray(directory.data) ? directory.data : []) {
      if (entry.archivedAt !== null) continue;
      for (const member of entry.memberPreview ?? []) {
        if (!member.isClient || member.userId === viewerUserId) continue;
        const row = byId.get(member.userId) ?? {
          displayName: member.displayName,
          projects: new Set<string>(),
        };
        const projectName = names.get(entry.projectId);
        if (projectName) row.projects.add(projectName);
        byId.set(member.userId, row);
      }
    }
    return [...byId.entries()]
      .map(([userId, row]) => ({
        userId,
        displayName: row.displayName,
        subtitle: [...row.projects].join(' · '),
        isClient: true,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [directory.data, projects.data, viewerUserId]);

  const matches = (person: Person) =>
    needle === '' || person.displayName.toLocaleLowerCase().includes(needle);
  const shownTeam = teamPeople.filter(matches);
  const shownClients = clientPeople.filter(matches);

  const open = useMutation({
    mutationFn: (userId: string) => openDirectConversation(api, organizationSlug, userId),
    onSuccess: (conversation) => {
      void queries.invalidateQueries({ queryKey: directKeys.list(organizationSlug) });
      onOpened(conversation);
    },
  });

  const rule = tOr(
    'NewMessageDialog.rule',
    'You can message a client only on a project you both work on.',
  );

  function errorText(error: unknown): string {
    if (error instanceof ApiRequestError) {
      if (error.status === 404 || error.status === 403) return rule;
      return error.message;
    }
    if (error instanceof NetworkError) {
      return tOr('NewMessageDialog.noAnswer', 'The server did not answer. Try again.');
    }
    return tOr('NewMessageDialog.genericError', 'Something went wrong. Try again.');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected === null || open.isPending) return;
    open.mutate(selected);
  }

  function renderPerson(person: Person) {
    const active = person.userId === selected;
    return (
      <li key={person.userId}>
        <button
          type="button"
          className="tm-newdm__person"
          aria-pressed={active}
          onClick={() => {
            setSelected(person.userId);
            open.reset();
          }}
        >
          <span
            className={`tm-chat-side__orb tm-newdm__orb${
              person.isClient ? ' tm-chat-side__orb--client' : ''
            }`}
            aria-hidden="true"
          >
            {initialsOf(person.displayName)}
          </span>
          <span className="tm-mention__text">
            <span className="tm-mention__name">{person.displayName}</span>
            {person.subtitle !== '' ? (
              <span className="tm-mention__sub">{person.subtitle}</span>
            ) : null}
          </span>
          {person.isClient ? (
            <span className="tm-chat-side__chip">{tOr('ChatSidebar.client', 'Client')}</span>
          ) : null}
        </button>
      </li>
    );
  }

  return (
    <div className="tm-newdm__scrim">
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="tm-newdm">
        <h2 id={titleId} className="tm-newdm__title">
          {tOr('NewMessageDialog.title', 'New message')}
        </h2>
        <p className="tm-newdm__lede">
          {tOr('NewMessageDialog.lede', 'Start a direct message with someone you work with.')}
        </p>
        <form onSubmit={submit} className="tm-newdm__form">
          <label htmlFor={toId} className="tm-newdm__label">
            {tOr('NewMessageDialog.to', 'To')}
          </label>
          <input
            id={toId}
            ref={inputRef}
            type="search"
            className="tm-newdm__input"
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          {shownTeam.length > 0 || shownClients.length > 0 ? (
            <div className="tm-newdm__results">
              {shownTeam.length > 0 ? (
                <>
                  <h3 className="tm-mention__group">
                    {tOr('NewMessageDialog.yourTeam', 'Your team')}
                  </h3>
                  <ul className="tm-mention__items">{shownTeam.map(renderPerson)}</ul>
                </>
              ) : null}
              {shownClients.length > 0 ? (
                <>
                  <h3 className="tm-mention__group">
                    {tOr('NewMessageDialog.clientsOnShared', 'Clients on projects you share')}
                  </h3>
                  <ul className="tm-mention__items">{shownClients.map(renderPerson)}</ul>
                </>
              ) : null}
            </div>
          ) : needle !== '' && !team.isPending && !directory.isPending ? (
            // 2026-10-31 live-test fix — Figma "Chat · New message — no matches · EN/AR
            // (2026-10-31 live-test fix)": say that nobody matched rather than show nothing.
            <div className="tm-newdm__results" role="status">
              <div className="tm-mention__empty">
                <p className="tm-mention__empty-title">
                  {tOr('NewMessageDialog.noMatchTitle', 'No one matches “{query}”').replace(
                    '{query}',
                    query.trim(),
                  )}
                </p>
                <p className="tm-mention__empty-body">
                  {organizationName === ''
                    ? tOr(
                        'NewMessageDialog.noMatchBodyWorkspace',
                        'Check the spelling, or invite them to this workspace first.',
                      )
                    : tOr(
                        'NewMessageDialog.noMatchBody',
                        'Check the spelling, or invite them to {organization} first.',
                      ).replace('{organization}', organizationName)}
                </p>
              </div>
            </div>
          ) : null}
          {open.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('NewMessageDialog.notOpened', 'Could not open this conversation')}
              live
            >
              {errorText(open.error)}
            </InlineAlert>
          ) : null}
          <p className="tm-newdm__rule">{rule}</p>
          <div className="tm-newdm__actions">
            <button type="button" className="tm-newdm__cancel" onClick={onClose}>
              {tOr('NewMessageDialog.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              className="tm-newdm__open"
              disabled={selected === null || open.isPending}
              aria-busy={open.isPending}
            >
              {tOr('NewMessageDialog.open', 'Open conversation')}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
