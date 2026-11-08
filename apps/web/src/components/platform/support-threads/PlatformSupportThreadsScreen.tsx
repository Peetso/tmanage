'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_SUPPORT_QUERY_KEY,
  fetchPlatformSupportThread,
  fetchPlatformSupportThreads,
  replyPlatformSupport,
  setPlatformSupportStatus,
} from '../../../lib/api/support';
import type {
  PlatformSupportDetail,
  PlatformSupportThread,
  SupportStatus,
} from '../../../lib/api/support';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { ChipGroup } from '../settings/settings-kit';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { platformErrorText } from '../shared/ReasonDialog';
import { missingPlatformPermission } from '../shared/usePlatformPermissions';
import '../../support/support.css';

/**
 * Row 55-17 · **Support** (`/platform/support`, Figma R39 L2-55-17-support "Platform ·
 * /platform/support"). The team's inbox of in-app support conversations from every workspace:
 * filter by status, open one, read the context the person sent, reply, or change the status.
 * Reading needs `platform.orgs.view`; replying and changing status `platform.orgs.edit` — the API
 * enforces both; the screen hides what the admin cannot do.
 */

const REPLY_PERMISSION = 'platform.orgs.edit';

type Filter = 'all' | SupportStatus;

const CAPSULE: Record<SupportStatus, CapsuleState> = {
  open: 'current',
  waiting: 'waiting',
  closed: 'done',
};

function usePlatformStatusText(): (status: SupportStatus) => string {
  const tOr = useTOr();
  return (status) =>
    status === 'open'
      ? tOr('PlatformSupport.statusOpen', 'Open')
      : status === 'waiting'
        ? tOr('PlatformSupport.statusWaiting', 'Waiting on customer')
        : tOr('PlatformSupport.statusClosed', 'Closed');
}

export function PlatformSupportThreadsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  return (
    <PlatformGate
      api={api}
      section="support"
      crumbs={[tOr('PlatformSupport.crumb', 'Platform'), tOr('PlatformSupport.title', 'Support')]}
      title={tOr('PlatformSupport.title', 'Support')}
      description={tOr(
        'PlatformSupport.description',
        'Conversations from people in every workspace. Your reply reaches them in TManage and by e-mail.',
      )}
    >
      {(me) => <InboxBody api={api} me={me} />}
    </PlatformGate>
  );
}

export function InboxBody({ api, me }: { readonly api: ApiClient; readonly me: PlatformMeView }) {
  const tOr = useTOr();
  const statusText = usePlatformStatusText();
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: PLATFORM_SUPPORT_QUERY_KEY,
    queryFn: () => fetchPlatformSupportThreads(api),
    refetchInterval: 60_000,
  });

  if (list.isPending) {
    return (
      <PlatformPageState
        state="loading"
        loadingLabel={tOr('PlatformSupport.loading', 'Loading support conversations')}
      />
    );
  }
  if (list.isError) {
    const missing = missingPlatformPermission(list.error);
    return missing !== null ? (
      <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
    ) : (
      <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
    );
  }

  const rows = list.data.filter((row) => filter === 'all' || row.status === filter);
  const filters = (['all', 'open', 'waiting', 'closed'] as const).map((value) => ({
    value,
    label: value === 'all' ? tOr('PlatformSupport.filterAll', 'All') : statusText(value),
  }));

  return (
    <div className="tm-stack">
      <ChipGroup
        label={tOr('PlatformSupport.filterLabel', 'Status')}
        value={filter}
        options={filters}
        onChange={setFilter}
      />
      {list.data.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={tOr('PlatformSupport.emptyTitle', 'No support conversations')}
          body={tOr(
            'PlatformSupport.emptyBody',
            'When someone writes from the help menu, the conversation appears here.',
          )}
        />
      ) : (
        <div className="tm-support-inbox">
          <ul
            className="tm-support-threads"
            aria-label={tOr('PlatformSupport.listLabel', 'Support conversations')}
          >
            {rows.map((row: PlatformSupportThread) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="tm-support-thread-row"
                  aria-current={selected === row.id ? 'true' : undefined}
                  onClick={() => setSelected(row.id)}
                >
                  <span className="tm-support-thread-row__text">
                    <span className="tm-support-thread-row__subject">{row.subject}</span>
                    <span className="tm-support-muted">
                      {[row.organizationSlug, row.startedByName].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <StateCapsule state={CAPSULE[row.status]}>{statusText(row.status)}</StateCapsule>
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <ThreadDetail
              key={selected}
              api={api}
              id={selected}
              canReply={me.permissions.includes(REPLY_PERMISSION)}
            />
          ) : (
            <p className="tm-support-muted">
              {tOr('PlatformSupport.pick', 'Choose a conversation to read it.')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadDetail({
  api,
  id,
  canReply,
}: {
  readonly api: ApiClient;
  readonly id: string;
  readonly canReply: boolean;
}) {
  const tOr = useTOr();
  const t = useT();
  const statusText = usePlatformStatusText();
  const queryClient = useQueryClient();
  const replyId = useId();
  const [reply, setReply] = useState('');
  const key = [...PLATFORM_SUPPORT_QUERY_KEY, id] as const;
  const detail = useQuery({ queryKey: key, queryFn: () => fetchPlatformSupportThread(api, id) });
  const done = (data: PlatformSupportDetail) => {
    queryClient.setQueryData(key, data);
    void queryClient.invalidateQueries({ queryKey: PLATFORM_SUPPORT_QUERY_KEY, exact: true });
  };
  const send = useMutation({
    mutationFn: () => replyPlatformSupport(api, id, reply.trim()),
    onSuccess: (data) => {
      setReply('');
      done(data);
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: SupportStatus) => setPlatformSupportStatus(api, id, status),
    onSuccess: done,
  });

  if (detail.isPending) {
    return <p className="tm-support-muted">{tOr('PlatformSupport.loadingOne', 'Loading')}</p>;
  }
  if (detail.isError) {
    return <InlineAlert tone="danger">{platformErrorText(detail.error, t)}</InlineAlert>;
  }
  const { thread, messages } = detail.data;
  return (
    <section className="tm-cc-card tm-support-stack" aria-labelledby={`${replyId}-title`}>
      <div className="tm-support-thread-head">
        <h2 id={`${replyId}-title`} className="tm-support-thread-head__subject">
          {thread.subject}
        </h2>
        <StateCapsule state={CAPSULE[thread.status]}>{statusText(thread.status)}</StateCapsule>
      </div>
      <section className="tm-support-context">
        <p className="tm-support-context__title">{tOr('PlatformSupport.context', 'Context')}</p>
        <dl>
          <div>
            <dt>{tOr('Support.contextWorkspace', 'Workspace')}</dt>
            <dd>{thread.organizationSlug ?? '—'}</dd>
          </div>
          <div>
            <dt>{tOr('PlatformSupport.person', 'Person')}</dt>
            <dd>{[thread.startedByName, thread.startedByEmail].filter(Boolean).join(' · ')}</dd>
          </div>
          <div>
            <dt>{tOr('Support.contextPage', 'Page')}</dt>
            <dd>{thread.contextPath ?? '—'}</dd>
          </div>
          <div>
            <dt>{tOr('Support.contextVersion', 'App version')}</dt>
            <dd>{thread.appVersion ?? '—'}</dd>
          </div>
        </dl>
      </section>
      <ol className="tm-support-messages">
        {messages.map((message) => (
          <li
            key={message.id}
            className={`tm-support-message tm-support-message--${message.authorKind}`}
          >
            <p className="tm-support-message__meta">
              <strong>
                {message.authorKind === 'platform'
                  ? `${tOr('Support.teamName', 'TManage support')}${message.authorName ? ` · ${message.authorName}` : ''}`
                  : (message.authorName ?? '')}
              </strong>{' '}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleString()}
              </time>
            </p>
            <p className="tm-support-message__body">{message.body}</p>
            {message.attachmentName ? (
              <p className="tm-support-muted">
                {tOr('PlatformSupport.attachment', 'Screenshot')}: {message.attachmentName}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {canReply ? (
        <form
          className="tm-support-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (reply.trim() !== '') send.mutate();
          }}
        >
          <div className="tm-support-textarea">
            <label htmlFor={replyId}>
              {tOr('PlatformSupport.replyAs', 'Reply as TManage support')}
            </label>
            <textarea
              id={replyId}
              rows={4}
              maxLength={5000}
              value={reply}
              placeholder={tOr('Support.replyPlaceholder', 'Write a reply')}
              onChange={(event) => setReply(event.target.value)}
            />
          </div>
          {send.isError ? (
            <InlineAlert tone="danger">{platformErrorText(send.error, t)}</InlineAlert>
          ) : null}
          {setStatus.isError ? (
            <InlineAlert tone="danger">{platformErrorText(setStatus.error, t)}</InlineAlert>
          ) : null}
          <div className="tm-support-actions">
            <Button
              type="button"
              tone="outline"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate(thread.status === 'closed' ? 'open' : 'closed')}
            >
              {thread.status === 'closed'
                ? tOr('PlatformSupport.reopen', 'Reopen')
                : tOr('PlatformSupport.markClosed', 'Mark as closed')}
            </Button>
            <Button type="submit" tone="ink" disabled={send.isPending || reply.trim() === ''}>
              {tOr('Support.sendReply', 'Send reply')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
