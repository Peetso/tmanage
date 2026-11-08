'use client';

import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, Select } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  CHANNEL_EVENT_KINDS,
  channelLinksQueryKey,
  channelUrlLooksRight,
  createChannelLink,
  listChannelLinks,
  removeChannelLink,
  resumeChannelLink,
  testChannelLink,
} from '../../lib/api/channel-links';
import type { ChannelKind, ChannelLinkView } from '../../lib/api/channel-links';
import { listProjects } from '../../lib/api/projects';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';

/**
 * 54-05 Slack + 54-06 Teams (R46 L2, Figma 587:33240 EN / 587:33395 AR) — **Control center >
 * Slack and Teams notices** at `/{orgSlug}/settings/channel-notices`. An owner pastes an
 * incoming-webhook URL, picks the project (or the whole workspace) and the notices to send, and
 * TManage posts them through the outbox with retries. No app to install. The URL is write-only:
 * a linked channel shows its host only.
 */

type TOr = ReturnType<typeof useTOr>;

const ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--s2)',
  alignItems: 'center',
};
const DEFAULT_EVENTS: readonly string[] = ['work.created', 'work.completed', 'approval.decided'];

export function channelEventLabel(kind: string, tOr: TOr): string {
  const english: Record<string, string> = {
    'work.created': 'Task created',
    'work.updated': 'Task changed',
    'work.completed': 'Task completed',
    'approval.decided': 'Approval decided',
    'document.published': 'Document published',
    'client_request.created': 'Client request',
    'client_request.transitioned': 'Client request moved',
    'meeting.scheduled': 'Meeting scheduled',
  };
  return tOr(`ChannelNotices.event.${kind.replace(/\./gu, '_')}`, english[kind] ?? kind);
}

export interface ChannelNoticesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

export function ChannelNoticesScreen({
  organizationSlug,
  organizationName,
  client,
}: ChannelNoticesScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="integrations"
      crumbs={[tOr('ChannelNotices.title', 'Slack and Teams notices')]}
      title={tOr('ChannelNotices.title', 'Slack and Teams notices')}
      description={tOr(
        'ChannelNotices.description',
        'Paste an incoming-webhook URL from Slack or Microsoft Teams. TManage posts the notices you pick into that channel. No app to install.',
      )}
    >
      <div className="tm-stack">
        <AddChannelForm api={api} organizationSlug={organizationSlug} />
        <LinkedChannels api={api} organizationSlug={organizationSlug} />
      </div>
    </ControlCenterShell>
  );
}

function errorText(error: unknown, tOr: TOr): string {
  if (error instanceof ApiRequestError) {
    const detail = error.details?.[0]?.message;
    return detail ? `${error.message} (${detail})` : error.message;
  }
  return tOr('ChannelNotices.genericError', 'Something went wrong. Try again.');
}

function AddChannelForm({ api, organizationSlug }: { api: ApiClient; organizationSlug: string }) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const [kind, setKind] = useState<ChannelKind>('slack');
  const [url, setUrl] = useState('');
  const [projectId, setProjectId] = useState('');
  const [events, setEvents] = useState<readonly string[]>(DEFAULT_EVENTS);
  const [tried, setTried] = useState(false);
  const urlOk = channelUrlLooksRight(kind, url);
  const create = useMutation({
    mutationFn: () =>
      createChannelLink(api, organizationSlug, kind, {
        webhookUrl: url.trim(),
        events,
        projectId: projectId === '' ? null : projectId,
        locale: locale.startsWith('ar') ? 'ar' : 'en',
      }),
    onSuccess: () => {
      setUrl('');
      setTried(false);
      void queryClient.invalidateQueries({ queryKey: channelLinksQueryKey(organizationSlug) });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!urlOk || events.length === 0) return;
    create.mutate();
  }

  function toggle(kindName: string, on: boolean) {
    setEvents((current) =>
      on ? [...new Set([...current, kindName])] : current.filter((k) => k !== kindName),
    );
  }

  return (
    <form
      className="tm-cc-card tm-stack tm-stack--tight"
      onSubmit={submit}
      noValidate
      aria-labelledby="channel-add-title"
    >
      <h2 id="channel-add-title" className="tm-cc-card__title">
        {tOr('ChannelNotices.addTitle', 'Add a channel')}
      </h2>
      <div className="tm-stack tm-stack--tight">
        <span className="tm-cc-eyebrow">{tOr('ChannelNotices.service', 'Service')}</span>
        <div role="radiogroup" aria-label={tOr('ChannelNotices.service', 'Service')} style={ROW}>
          {(['slack', 'teams'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              className={`tm-cc-pill${kind === value ? ' tm-cc-pill--on' : ''}`}
              onClick={() => setKind(value)}
            >
              {value === 'slack' ? 'Slack' : 'Microsoft Teams'}
            </button>
          ))}
        </div>
      </div>
      <Field
        label={tOr('ChannelNotices.url', 'Incoming-webhook URL')}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        value={url}
        placeholder={
          kind === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://….webhook.office.com/…'
        }
        onChange={(event) => setUrl(event.target.value)}
        hint={tOr(
          'ChannelNotices.urlHint',
          'Only hooks.slack.com and Teams webhook addresses are accepted.',
        )}
        {...(tried && !urlOk
          ? {
              error: tOr(
                'ChannelNotices.urlInvalid',
                'This is not a Slack or Teams incoming-webhook URL.',
              ),
            }
          : {})}
      />
      <Select
        label={tOr('ChannelNotices.project', 'Project')}
        value={projectId}
        onChange={(event) => setProjectId(event.target.value)}
      >
        <option value="">{tOr('ChannelNotices.wholeWorkspace', 'Whole workspace')}</option>
        {(projects.data ?? []).map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </Select>
      <fieldset className="tm-stack tm-stack--tight" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="tm-cc-eyebrow">{tOr('ChannelNotices.kinds', 'Notices to send')}</legend>
        <div style={ROW}>
          {CHANNEL_EVENT_KINDS.map((kindName) => (
            <Checkbox
              key={kindName}
              label={channelEventLabel(kindName, tOr)}
              checked={events.includes(kindName)}
              onChange={(event) => toggle(kindName, event.target.checked)}
            />
          ))}
        </div>
        {tried && events.length === 0 ? (
          <span className="tm-cc-note">
            {tOr('ChannelNotices.pickOne', 'Pick at least one notice.')}
          </span>
        ) : null}
      </fieldset>
      {create.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('ChannelNotices.addFailed', 'The channel was not added.')}
          live
        >
          {errorText(create.error, tOr)}
        </InlineAlert>
      ) : null}
      <div>
        <Button type="submit" tone="lime" disabled={create.isPending}>
          {tOr('ChannelNotices.add', 'Add channel')}
        </Button>
      </div>
    </form>
  );
}

function LinkedChannels({ api, organizationSlug }: { api: ApiClient; organizationSlug: string }) {
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const key = channelLinksQueryKey(organizationSlug);
  const links = useQuery({ queryKey: key, queryFn: () => listChannelLinks(api, organizationSlug) });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const act = useMutation({
    mutationFn: async ({
      link,
      what,
    }: {
      link: ChannelLinkView;
      what: 'test' | 'remove' | 'resume';
    }) => {
      if (what === 'test') await testChannelLink(api, organizationSlug, link.id);
      else if (what === 'remove') await removeChannelLink(api, organizationSlug, link.id);
      else await resumeChannelLink(api, organizationSlug, link.id);
      return what;
    },
    onSuccess: (what) => {
      setMessage(
        what === 'test'
          ? {
              tone: 'success',
              text: tOr('ChannelNotices.testSent', 'A test notice is on its way.'),
            }
          : null,
      );
      void refresh();
    },
    onError: (error) => setMessage({ tone: 'danger', text: errorText(error, tOr) }),
  });
  const projectName = new Map((projects.data ?? []).map((project) => [project.id, project.name]));

  return (
    <section className="tm-cc-card tm-stack tm-stack--tight" aria-labelledby="channel-linked-title">
      <h2 id="channel-linked-title" className="tm-cc-card__title">
        {tOr('ChannelNotices.linked', 'Linked channels')}
      </h2>
      {message ? (
        <InlineAlert tone={message.tone} live>
          {message.text}
        </InlineAlert>
      ) : null}
      {links.isError ? (
        <InlineAlert tone="danger" live>
          {errorText(links.error, tOr)}
        </InlineAlert>
      ) : null}
      {links.isSuccess && links.data.length === 0 ? (
        <p className="tm-cc-note">{tOr('ChannelNotices.empty', 'No channel is linked yet.')}</p>
      ) : null}
      <ul className="tm-stack tm-stack--tight" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {(links.data ?? []).map((link) => {
          const paused = link.status !== 'active';
          const where =
            link.projectId === null
              ? tOr('ChannelNotices.wholeWorkspace', 'Whole workspace')
              : (projectName.get(link.projectId) ?? tOr('ChannelNotices.project', 'Project'));
          return (
            <li
              key={link.id}
              className="tm-cc-card"
              style={{ ...ROW, justifyContent: 'space-between' }}
              data-testid="channel-link"
            >
              <div className="tm-stack tm-stack--tight">
                <strong>
                  {link.kind === 'slack' ? 'Slack' : 'Microsoft Teams'} · {where}
                </strong>
                <span className="tm-cc-note" dir="ltr">
                  {link.urlHost}
                </span>
              </div>
              <div style={ROW}>
                <span className={`tm-cc-pill${paused ? '' : ' tm-cc-pill--on'}`}>
                  {paused
                    ? tOr('ChannelNotices.paused', 'Paused')
                    : tOr('ChannelNotices.active', 'Active')}
                </span>
                <Button
                  type="button"
                  tone="outline"
                  size="compact"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ link, what: paused ? 'resume' : 'test' })}
                >
                  {paused
                    ? tOr('ChannelNotices.resume', 'Resume')
                    : tOr('ChannelNotices.test', 'Send test')}
                </Button>
                <Button
                  type="button"
                  tone="destructive"
                  size="compact"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ link, what: 'remove' })}
                >
                  {tOr('ChannelNotices.remove', 'Remove')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
