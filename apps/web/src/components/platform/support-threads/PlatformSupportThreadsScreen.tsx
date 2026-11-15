'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_SUPPORT_QUERY_KEY,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  SUPPORT_TARGETS_QUERY_KEY,
  fetchPlatformSupportThread,
  fetchPlatformSupportThreads,
  fetchSupportTargets,
  platformSupportListKey,
  replyPlatformSupport,
  setPlatformSupportStatus,
} from '../../../lib/api/support';
import type {
  PlatformSupportDetail,
  PlatformSupportThread,
  SupportPriority,
  SupportStatus,
} from '../../../lib/api/support';
import { useT } from '../../../lib/i18n/use-t';
import {
  REQUEST_STATE_TONE,
  matchesChip,
  nextDue,
  requestState,
  slaSummary,
} from '../../../lib/support-sla-text';
import type { InboxChip, RequestState } from '../../../lib/support-sla-text';
import { SupportBadge } from '../../support/SupportBadge';
import { isToday, planName, shortWhen, useSupportText } from '../../support/support-text';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { platformErrorText } from '../shared/ReasonDialog';
import { missingPlatformPermission } from '../shared/usePlatformPermissions';
import '../../support/support.css';

/**
 * Rows 55-17 + 57-10 · **Support inbox** (`/platform/support`, Figma 614:35191). The team's queue
 * of support requests from every workspace with the response clock the API computes (business
 * hours, Sun–Thu 09:00–18:00 in each workspace's time zone): quick filters (open, due within two
 * hours, late, answered today), priority and status, the next request due, the published targets,
 * and one request's thread to reply and set waiting or resolved. Reading needs
 * `platform.orgs.view`; replying and changing status `platform.orgs.edit` — the API enforces
 * both; the screen hides what the admin cannot do.
 */

const REPLY_PERMISSION = 'platform.orgs.edit';
const CHIPS: readonly InboxChip[] = ['open', 'dueSoon', 'late', 'answeredToday', 'all'];

function usePlatformStateText(): (state: RequestState) => string {
  const { tOr } = useSupportText();
  return (state) =>
    ({
      resolved: tOr('PlatformSupport.stateResolved', 'Resolved'),
      withCustomer: tOr('PlatformSupport.statusWaiting', 'Waiting on customer'),
      late: tOr('PlatformSupport.stateLate', 'Late'),
      awaitingReply: tOr('PlatformSupport.stateAwaiting', 'Waiting'),
      newReply: tOr('PlatformSupport.stateNewReply', 'New reply'),
      answered: tOr('PlatformSupport.stateAnswered', 'Answered'),
    })[state];
}

export function PlatformSupportThreadsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const { tOr } = useSupportText();
  return (
    <PlatformGate
      api={api}
      section="support"
      crumbs={[tOr('PlatformSupport.crumbPlatform', 'TManage platform')]}
      title={tOr('PlatformSupport.inboxTitle', 'Support inbox')}
      description={tOr(
        'PlatformSupport.inboxDescription',
        'Clocks count business hours only: Sun–Thu, 9:00–18:00 in each workspace’s time zone.',
      )}
    >
      {(me) => <InboxBody api={api} me={me} />}
    </PlatformGate>
  );
}

export function InboxBody({ api, me }: { readonly api: ApiClient; readonly me: PlatformMeView }) {
  const text = useSupportText();
  const { tOr } = text;
  const [chip, setChip] = useState<InboxChip>('open');
  const [priority, setPriority] = useState<SupportPriority | null>(null);
  const [status, setStatus] = useState<SupportStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showTargets, setShowTargets] = useState(false);
  const filter = { breached: chip === 'late', priority };
  const list = useQuery({
    queryKey: platformSupportListKey(filter),
    queryFn: () => fetchPlatformSupportThreads(api, filter),
    refetchInterval: 60_000,
  });
  // The chip counts read the unfiltered queue (same priority), so each chip says what it holds.
  const counts = useQuery({
    queryKey: platformSupportListKey({ priority }),
    queryFn: () => fetchPlatformSupportThreads(api, { priority }),
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

  const rows = list.data
    .filter((row) => matchesChip(row, chip, (iso) => isToday(iso)))
    .filter((row) => status === null || row.status === status);
  const chipLabel = (value: InboxChip): string =>
    ({
      open: tOr('PlatformSupport.chipOpen', 'Open'),
      dueSoon: tOr('PlatformSupport.chipDueSoon', 'Due within 2 h'),
      late: tOr('PlatformSupport.stateLate', 'Late'),
      answeredToday: tOr('PlatformSupport.chipAnsweredToday', 'Answered today'),
      all: tOr('PlatformSupport.filterAll', 'All'),
    })[value];
  const count = (value: InboxChip): number | null =>
    counts.data
      ? counts.data.filter((row) => matchesChip(row, value, (iso) => isToday(iso))).length
      : null;
  const next = nextDue(counts.data ?? list.data);

  return (
    <div className="tm-stack">
      <div className="tm-inbox-toolbar">
        <div
          className="tm-inbox-chips"
          role="group"
          aria-label={tOr('PlatformSupport.filterLabel', 'Status')}
        >
          {CHIPS.map((value) => {
            const n = count(value);
            return (
              <button
                key={value}
                type="button"
                className={`tm-inbox-chip${value === 'late' ? ' tm-inbox-chip--late' : ''}`}
                aria-pressed={chip === value}
                onClick={() => setChip(value)}
              >
                {n === null ? chipLabel(value) : `${chipLabel(value)} · ${n}`}
              </button>
            );
          })}
        </div>
        <div className="tm-inbox-actions">
          <Button type="button" tone="outline" onClick={() => setShowTargets((open) => !open)}>
            {tOr('PlatformSupport.targets', 'Response targets')}
          </Button>
          <Button
            type="button"
            tone="ink"
            disabled={next === null}
            onClick={() => (next ? setSelected(next.id) : undefined)}
          >
            {tOr('PlatformSupport.openNextDue', 'Open next due')}
          </Button>
        </div>
      </div>
      <div className="tm-inbox-selects">
        <Select
          label={tOr('PlatformSupport.priority', 'Priority')}
          value={priority ?? ''}
          onChange={(event) =>
            setPriority(event.target.value === '' ? null : (event.target.value as SupportPriority))
          }
        >
          <option value="">{tOr('PlatformSupport.anyPriority', 'Any priority')}</option>
          {SUPPORT_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {text.priority(value)}
            </option>
          ))}
        </Select>
        <Select
          label={tOr('PlatformSupport.statusLabel', 'Status')}
          value={status ?? ''}
          onChange={(event) =>
            setStatus(event.target.value === '' ? null : (event.target.value as SupportStatus))
          }
        >
          <option value="">{tOr('PlatformSupport.anyStatus', 'Any status')}</option>
          {SUPPORT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value === 'open'
                ? tOr('PlatformSupport.statusOpen', 'Open')
                : value === 'waiting'
                  ? tOr('PlatformSupport.statusWaiting', 'Waiting on customer')
                  : tOr('PlatformSupport.stateResolved', 'Resolved')}
            </option>
          ))}
        </Select>
      </div>
      {showTargets ? <TargetsPanel api={api} /> : null}
      {rows.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={tOr('PlatformSupport.emptyFiltered', 'Nothing here right now')}
          body={tOr(
            'PlatformSupport.emptyBody',
            'When someone writes from the help menu, the conversation appears here.',
          )}
        />
      ) : (
        <InboxTable rows={rows} selected={selected} onSelect={setSelected} />
      )}
      <p className="tm-support-muted">
        {tOr(
          'PlatformSupport.clockNote',
          'The clock stops when someone on the team sends the first reply. A plan change later doesn’t shorten a clock that is already running.',
        )}
      </p>
      {selected ? (
        <ThreadDetail
          key={selected}
          api={api}
          id={selected}
          canReply={me.permissions.includes(REPLY_PERMISSION)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function ReplyDue({ row }: { readonly row: PlatformSupportThread }) {
  const text = useSupportText();
  const { tOr } = text;
  const summary = slaSummary(row);
  if (row.status === 'closed' && summary.kind !== 'answered') return <span>—</span>;
  switch (summary.kind) {
    case 'late':
      return (
        <span className="tm-sla-line--late">
          {text.fill(tOr('PlatformSupport.lateBy', 'Late by {time}'), {
            time: text.duration(summary.minutes),
          })}
        </span>
      );
    case 'due':
      return (
        <span className={summary.soon ? 'tm-sla-line--due' : undefined}>
          {text.fill(tOr('PlatformSupport.left', '{time} left'), {
            time: text.duration(summary.minutes),
          })}
        </span>
      );
    case 'answered':
      return (
        <span className={summary.late ? 'tm-sla-line--late' : 'tm-sla-line--answered'}>
          {text.fill(tOr('GetHelp.answeredIn', 'Answered in {time}'), {
            time: text.duration(summary.minutes),
          })}
        </span>
      );
    default:
      return <span>—</span>;
  }
}

function InboxTable({
  rows,
  selected,
  onSelect,
}: {
  readonly rows: readonly PlatformSupportThread[];
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const text = useSupportText();
  const { tOr } = text;
  const stateText = usePlatformStateText();
  return (
    <div className="tm-inbox-table-wrap">
      <table className="tm-inbox-table">
        <caption className="tm-visually-hidden">
          {tOr('PlatformSupport.listLabel', 'Support conversations')}
        </caption>
        <thead>
          <tr>
            <th scope="col">{tOr('PlatformSupport.colRequest', 'Request')}</th>
            <th scope="col">{tOr('PlatformSupport.colWorkspace', 'Workspace')}</th>
            <th scope="col">{tOr('PlatformSupport.colPlan', 'Plan')}</th>
            <th scope="col">{tOr('PlatformSupport.colTarget', 'Target')}</th>
            <th scope="col">{tOr('PlatformSupport.colReplyDue', 'Reply due')}</th>
            <th scope="col">{tOr('PlatformSupport.statusLabel', 'Status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const state = requestState(row);
            return (
              <tr key={row.id} aria-current={selected === row.id ? 'true' : undefined}>
                <th scope="row">
                  <button type="button" className="tm-inbox-open" onClick={() => onSelect(row.id)}>
                    {row.subject}
                  </button>
                  {row.priority === 'high' || row.priority === 'urgent' ? (
                    <span className="tm-support-muted"> · {text.priority(row.priority)}</span>
                  ) : null}
                </th>
                <td>{row.organizationName ?? row.organizationSlug ?? '—'}</td>
                <td>{planName(row.plan)}</td>
                <td>{row.sla ? text.target(row.sla.firstResponse.targetMinutes) : '—'}</td>
                <td>
                  <ReplyDue row={row} />
                </td>
                <td>
                  <SupportBadge tone={REQUEST_STATE_TONE[state]}>{stateText(state)}</SupportBadge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TargetsPanel({ api }: { readonly api: ApiClient }) {
  const text = useSupportText();
  const { tOr } = text;
  const targets = useQuery({
    queryKey: SUPPORT_TARGETS_QUERY_KEY,
    queryFn: () => fetchSupportTargets(api),
    staleTime: 3_600_000,
  });
  return (
    <section className="tm-cc-card tm-support-stack" aria-labelledby="tm-inbox-targets">
      <h2 id="tm-inbox-targets" className="tm-gethelp-card__title">
        {tOr('PlatformSupport.targets', 'Response targets')}
      </h2>
      {targets.isPending ? (
        <p className="tm-support-muted">{tOr('PlatformSupport.loadingOne', 'Loading')}</p>
      ) : targets.isError ? (
        <InlineAlert tone="danger">
          {tOr(
            'PlatformSupport.targetsError',
            'The targets could not be loaded. Try again in a moment.',
          )}
        </InlineAlert>
      ) : (
        <>
          <dl className="tm-inbox-targets">
            {targets.data.plans.map((row) => (
              <div key={row.plan}>
                <dt>{planName(row.plan)}</dt>
                <dd>{text.target(row.firstResponseBusinessMinutes)}</dd>
              </div>
            ))}
          </dl>
          <p className="tm-support-muted">
            {targets.data.priorities
              .map(
                (row) =>
                  `${text.priority(row.priority)}: ${text.fill(
                    tOr('PlatformSupport.resolveWithin', 'resolve within {time}'),
                    { time: text.target(row.resolutionMinutes) },
                  )}`,
              )
              .join(' · ')}
          </p>
        </>
      )}
    </section>
  );
}

function ThreadDetail({
  api,
  id,
  canReply,
  onClose,
}: {
  readonly api: ApiClient;
  readonly id: string;
  readonly canReply: boolean;
  readonly onClose: () => void;
}) {
  const text = useSupportText();
  const { tOr } = text;
  const t = useT();
  const stateText = usePlatformStateText();
  const queryClient = useQueryClient();
  const replyId = useId();
  const [reply, setReply] = useState('');
  const key = [...PLATFORM_SUPPORT_QUERY_KEY, id] as const;
  const detail = useQuery({ queryKey: key, queryFn: () => fetchPlatformSupportThread(api, id) });
  const done = (data: PlatformSupportDetail) => {
    queryClient.setQueryData(key, data);
    void queryClient.invalidateQueries({ queryKey: [...PLATFORM_SUPPORT_QUERY_KEY, 'list'] });
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
  const state = requestState(thread);
  const resolution = thread.sla?.resolution ?? null;
  return (
    <section className="tm-cc-card tm-support-stack" aria-labelledby={`${replyId}-title`}>
      <div className="tm-support-thread-head">
        <h2 id={`${replyId}-title`} className="tm-support-thread-head__subject">
          {thread.subject}
        </h2>
        <SupportBadge tone={REQUEST_STATE_TONE[state]}>{stateText(state)}</SupportBadge>
        <Button type="button" tone="text" onClick={onClose}>
          {tOr('Support.closePanel', 'Close')}
        </Button>
      </div>
      <section className="tm-support-context">
        <p className="tm-support-context__title">{tOr('PlatformSupport.context', 'Context')}</p>
        <dl>
          <div>
            <dt>{tOr('Support.contextWorkspace', 'Workspace')}</dt>
            <dd>{thread.organizationName ?? thread.organizationSlug ?? '—'}</dd>
          </div>
          <div>
            <dt>{tOr('PlatformSupport.person', 'Person')}</dt>
            <dd>{[thread.startedByName, thread.startedByEmail].filter(Boolean).join(' · ')}</dd>
          </div>
          <div>
            <dt>{tOr('GetHelp.topic', 'Topic')}</dt>
            <dd>{`${text.category(thread.category)} · ${text.priority(thread.priority)} · ${planName(thread.plan)}`}</dd>
          </div>
          <div>
            <dt>{tOr('PlatformSupport.colReplyDue', 'Reply due')}</dt>
            <dd>
              <ReplyDue row={thread} />
            </dd>
          </div>
          {resolution ? (
            <div>
              <dt>{tOr('PlatformSupport.resolution', 'Resolution')}</dt>
              <dd>
                {resolution.resolvedAt
                  ? shortWhen(resolution.resolvedAt, true)
                  : thread.sla?.paused
                    ? tOr('PlatformSupport.paused', 'Paused while we wait on the customer')
                    : resolution.dueAt
                      ? text.fill(tOr('PlatformSupport.dueBy', 'Due {when}'), {
                          when: shortWhen(resolution.dueAt, true),
                        })
                      : '—'}
              </dd>
            </div>
          ) : null}
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
              <time dateTime={message.createdAt}>{shortWhen(message.createdAt, true)}</time>
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
            {thread.status === 'closed' ? (
              <Button
                type="button"
                tone="outline"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate('open')}
              >
                {tOr('PlatformSupport.reopen', 'Reopen')}
              </Button>
            ) : (
              <>
                {thread.status === 'waiting' ? null : (
                  <Button
                    type="button"
                    tone="outline"
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate('waiting')}
                  >
                    {tOr('PlatformSupport.markWaiting', 'Waiting on customer')}
                  </Button>
                )}
                <Button
                  type="button"
                  tone="outline"
                  disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate('closed')}
                >
                  {tOr('PlatformSupport.markResolved', 'Mark resolved')}
                </Button>
              </>
            )}
            <Button type="submit" tone="ink" disabled={send.isPending || reply.trim() === ''}>
              {tOr('Support.sendReply', 'Send reply')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
