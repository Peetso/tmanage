'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { chatKeys } from '../../lib/api/chat';
import { createConversation } from '../../lib/api/conversations';
import { ApiRequestError } from '../../lib/api/errors';
import { listProjects } from '../../lib/api/projects';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/chat.css';

export interface NewChannelFormProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /**
   * Where the new channel opens. Default: the studio channel page, `/<slug>/chat/<id>` — the
   * same address `NewGroupDialog` opens after "Create group".
   */
  readonly channelHref?: (conversationId: string) => string;
}

export function defaultChannelHref(organizationSlug: string, conversationId: string): string {
  return `/${encodeURIComponent(organizationSlug)}/chat/${encodeURIComponent(conversationId)}`;
}

/**
 * R7 slice 2: "New channel" on a project, carried over from the retired channel browser
 * (`ChatScreen`) into the chat list's empty pane. Disabled until the projects arrive, so a name
 * typed before hydration is never silently erased.
 */
export function NewChannelForm({ api, organizationSlug, channelHref }: NewChannelFormProps) {
  const tOr = useTOr();
  const router = useRouter();
  const queries = useQueryClient();
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const create = useMutation({
    mutationFn: () => createConversation(api, organizationSlug, { projectId, name }),
    onSuccess: (created) => {
      setName('');
      void queries.invalidateQueries({ queryKey: chatKeys.all(organizationSlug) });
      void queries.invalidateQueries({ queryKey: ['conversations', organizationSlug] });
      // A3: open the channel just made, rather than leaving the cleared form behind.
      router.push(
        channelHref === undefined
          ? defaultChannelHref(organizationSlug, created.id)
          : channelHref(created.id),
      );
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (projectId === '' || name.trim() === '') return;
    create.mutate();
  }

  return (
    <section className="tm-chat-create" aria-labelledby="tm-chat-create-h">
      <h2 id="tm-chat-create-h" className="tm-chat-eyebrow">
        {tOr('ChatList.newChannel', 'New channel')}
      </h2>
      <form noValidate className="tm-stack" onSubmit={submit}>
        <fieldset className="tm-chat-create__fields" disabled={projects.isPending}>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-chat-new-project">
              {tOr('ChatList.projectLabel', 'Project')}
            </label>
            <select
              id="tm-chat-new-project"
              className="tm-field__control"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              required
            >
              <option value="">{tOr('ChatList.chooseProject', 'Choose a project')}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-chat-new-name">
              {tOr('ChatList.channelNameLabel', 'Channel name')}
            </label>
            <input
              id="tm-chat-new-name"
              className="tm-field__control"
              value={name}
              onChange={(event) => setName(event.target.value)}
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
            loadingLabel={tOr('ChatList.creating', 'Creating…')}
            disabled={projectId === '' || name.trim() === ''}
          >
            {tOr('ChatList.createChannel', 'Create channel')}
          </Button>
        </fieldset>
        {create.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('ChatList.createError', 'Could not create the channel')}
            live
          >
            {create.error instanceof ApiRequestError
              ? create.error.message
              : tOr('ChatList.noAnswer', 'The server did not answer. Try again.')}
          </InlineAlert>
        ) : null}
      </form>
    </section>
  );
}
