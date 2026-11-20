'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { createGroup } from '../../lib/api/chat-groups';
import { listProjects } from '../../lib/api/projects';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useMembers } from '../../lib/use-members';
import { initialsOf } from './channel-browser';
import { CHAT_WORKSPACE_PARAM, chatHref, chatWorkspaceFrom } from './chat-workspaces';
import './groups.css';

export interface NewGroupDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly onClose: () => void;
  readonly onCreated: (conversationId: string) => void;
}

/**
 * R7 slice 3 — the New group sheet (Figma 493:29244 / 493:29401): name, description and the people
 * to add, team members and client contacts alike (clients carry a "Client" chip). The creator is
 * the group's first admin; each person added appears in the transcript as "X added Y".
 *
 * R38 G1: "Linked to" — General (the default: linked to no project, its members are the creator
 * and the people picked) or a project (that project's channel, which its team joins).
 */
export function NewGroupDialog({ api, organizationSlug, onClose, onCreated }: NewGroupDialogProps) {
  const tOr = useTOr();
  const titleId = useId();
  const queries = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const [link, setLink] = useState<'general' | 'project'>('general');
  const [projectId, setProjectId] = useState('');
  const people = useMembers(api, organizationSlug, search);
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
    enabled: link === 'project',
  });
  const linkedToProject = link === 'project';
  const ready = name.trim() !== '' && (!linkedToProject || projectId !== '');

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const create = useMutation({
    mutationFn: () =>
      createGroup(api, organizationSlug, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        memberUserIds: linkedToProject ? [] : [...picked.keys()],
        ...(linkedToProject ? { projectId } : {}),
      }),
    onSuccess: (group) => {
      void queries.invalidateQueries({ queryKey: ['chat'] });
      onCreated(group.id);
    },
  });

  function toggle(userId: string, displayName: string): void {
    const next = new Map(picked);
    if (next.has(userId)) next.delete(userId);
    else next.set(userId, displayName);
    setPicked(next);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (ready && !create.isPending) create.mutate();
  }

  return (
    <div
      className="tm-chatgroup-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        noValidate
        className="tm-chatgroup-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
      >
        <h2 id={titleId} className="tm-chatgroup-sheet__title">
          {tOr('ChatGroups.newGroup', 'New group')}
        </h2>
        <label className="tm-chatgroup__field">
          <span className="tm-chatgroup__label">{tOr('ChatGroups.name', 'Group name')}</span>
          <input
            className="tm-chatgroup__input"
            value={name}
            maxLength={120}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="tm-chatgroup__field">
          <span className="tm-chatgroup__label">
            {tOr('ChatGroups.description', 'Description (optional)')}
          </span>
          <input
            className="tm-chatgroup__input"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <fieldset className="tm-chatgroup__link">
          <legend className="tm-chatgroup__label">{tOr('ChatGroups.linkedTo', 'Linked to')}</legend>
          <label className="tm-chatgroup__choice" data-checked={!linkedToProject}>
            <input
              type="radio"
              name="tm-chatgroup-link"
              value="general"
              checked={!linkedToProject}
              onChange={() => setLink('general')}
            />
            <span className="tm-chatgroup__choice-title">
              {tOr('ChatGroups.general', 'General (not linked to a project)')}
            </span>
            <span className="tm-chatgroup__choice-hint">
              {tOr('ChatGroups.generalHint', 'For you and the people you pick in this workspace')}
            </span>
          </label>
          <label className="tm-chatgroup__choice" data-checked={linkedToProject}>
            <input
              type="radio"
              name="tm-chatgroup-link"
              value="project"
              checked={linkedToProject}
              onChange={() => setLink('project')}
            />
            <span className="tm-chatgroup__choice-title">
              {tOr('ChatGroups.project', 'A project')}
            </span>
            <span className="tm-chatgroup__choice-hint">
              {tOr('ChatGroups.projectHint', 'Everyone on the project joins it')}
            </span>
          </label>
          {linkedToProject ? (
            <select
              className="tm-chatgroup__input"
              value={projectId}
              required
              aria-label={tOr('ChatGroups.chooseProject', 'Choose a project')}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">{tOr('ChatGroups.chooseProject', 'Choose a project')}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null}
        </fieldset>
        {linkedToProject ? null : (
          <>
            <p className="tm-chatgroup__label">
              {tOr('ChatGroups.addMembers', 'Add members')}{' '}
              <span className="tm-chatgroup__chip">
                {tOr('ChatGroups.selected', '{count} selected').replace(
                  '{count}',
                  String(picked.size),
                )}
              </span>
            </p>
            <input
              className="tm-chatgroup__input"
              value={search}
              placeholder={tOr('ChatGroups.searchPeople', 'Search people')}
              aria-label={tOr('ChatGroups.searchPeople', 'Search people')}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ul className="tm-chatgroup-members tm-chatgroup-members--pick">
              {people.members.map((person) => (
                <li key={person.userId}>
                  <label className="tm-chatgroup-member">
                    <span className="tm-chatgroup__avatar" aria-hidden="true">
                      {initialsOf(person.displayName)}
                    </span>
                    <span className="tm-chatgroup-member__name">{person.displayName}</span>
                    {person.role.startsWith('client') ? (
                      <span className="tm-chatgroup__chip tm-chatgroup__chip--client">
                        {tOr('ChatGroups.client', 'Client')}
                      </span>
                    ) : null}
                    <input
                      type="checkbox"
                      checked={picked.has(person.userId)}
                      onChange={() => toggle(person.userId, person.displayName)}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {create.isError ? (
          <p className="tm-chatgroup__error" role="alert">
            {tOr('ChatGroups.createError', 'The group could not be created.')}
          </p>
        ) : null}
        <div className="tm-chatgroup-sheet__actions">
          <button type="button" className="tm-chatgroup__btn" onClick={onClose}>
            {tOr('ChatGroups.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            className="tm-chatgroup__btn tm-chatgroup__btn--primary"
            disabled={!ready || create.isPending}
          >
            {tOr('ChatGroups.create', 'Create group')}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Mounts {@link NewGroupDialog} while the URL carries `?new=group` (the chat list's "New group"
 * link). Closing drops the parameter; creating opens the new group. R38 G2: a `?ws=` beside it
 * names the workspace whose chats are on screen; the group is made there and the URLs keep it.
 */
export function NewGroupLauncher({
  organizationSlug,
  api,
}: {
  readonly organizationSlug: string;
  readonly api?: ApiClient;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  if (params.get('new') !== 'group') return null;
  const chatSlug = chatWorkspaceFrom(organizationSlug, params.get(CHAT_WORKSPACE_PARAM));
  return (
    <NewGroupDialog
      api={api ?? browserApiClient()}
      organizationSlug={chatSlug ?? organizationSlug}
      onClose={() =>
        router.replace(
          chatSlug === undefined ? pathname : `${pathname}?${CHAT_WORKSPACE_PARAM}=${chatSlug}`,
        )
      }
      onCreated={(id) => router.push(chatHref(organizationSlug, chatSlug, id))}
    />
  );
}
