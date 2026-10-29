'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, SearchField, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  endPlatformSession,
  fetchPlatformSuspicious,
  listPlatformLiveSessions,
  listPlatformSignIns,
  listPlatformStepUps,
} from '../../../lib/api/platform-activity';
import type {
  PlatformLiveSessionView,
  PlatformSignInView,
  PlatformStepUpView,
  PlatformSuspiciousView,
} from '../../../lib/api/platform-activity';
import { useT } from '../../../lib/i18n/use-t';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { ReasonDialog } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ACTIVITY_KEY, ActivityFrame, filterHref, moment } from './ActivityFrame';

/**
 * C3 · Access (platform-admin v2 · PA-09) — sign-ins, live sessions (end one, with a reason),
 * step-ups and suspicious patterns. IPs and devices show only with `platform.activity.detail`.
 */

type AccessView = 'sign-ins' | 'sessions' | 'step-ups' | 'suspicious';

const VIEWS: readonly AccessView[] = ['sign-ins', 'sessions', 'step-ups', 'suspicious'];

export function AccessLogScreen({
  client,
  initialView,
}: ScreenProps & { initialView?: string | undefined }) {
  const api = client ?? browserApiClient();
  const start = (VIEWS as readonly string[]).includes(initialView ?? '')
    ? (initialView as AccessView)
    : 'sign-ins';
  return (
    <ActivityFrame api={api} tab="access">
      {() => <AccessBody api={api} start={start} />}
    </ActivityFrame>
  );
}

function AccessBody({ api, start }: { api: ApiClient; start: AccessView }) {
  const t = useT();
  const [view, setView] = useState<AccessView>(start);
  const labels: Record<AccessView, string> = {
    'sign-ins': t('PlatformActivity.viewSignIns'),
    sessions: t('PlatformActivity.viewSessions'),
    'step-ups': t('PlatformActivity.viewStepUps'),
    suspicious: t('PlatformActivity.viewSuspicious'),
  };
  return (
    <div className="tm-stack">
      <div className="tm-chip-row" role="group" aria-label={t('PlatformActivity.accessViews')}>
        {VIEWS.map((id) => (
          <button
            key={id}
            type="button"
            className={view === id ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {labels[id]}
          </button>
        ))}
      </div>
      {view === 'sign-ins' ? <SignIns api={api} /> : null}
      {view === 'sessions' ? <Sessions api={api} /> : null}
      {view === 'step-ups' ? <StepUps api={api} /> : null}
      {view === 'suspicious' ? <Suspicious api={api} /> : null}
    </div>
  );
}

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 250);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

function SignIns({ api }: { api: ApiClient }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [outcome, setOutcome] = useState('');
  const search = useDebounced(q);
  const filter = { ...(search ? { q: search } : {}), ...(outcome ? { outcome } : {}) };
  const list = useInfiniteQuery({
    queryKey: [...ACTIVITY_KEY, 'sign-ins', filter],
    queryFn: ({ pageParam }) => listPlatformSignIns(api, filter, pageParam || null),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.signIns) ?? [];
  const columns: PlatformColumn<PlatformSignInView>[] = [
    { id: 'when', header: t('PlatformActivity.colWhen'), cell: (row) => moment(row.occurredAt) },
    {
      id: 'who',
      header: t('PlatformActivity.colWho'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-cell-title">{row.displayName ?? row.email ?? '—'}</span>
          <span className="tm-cc-cell-sub">{row.email ?? ''}</span>
        </div>
      ),
    },
    {
      id: 'outcome',
      header: t('PlatformActivity.colOutcome'),
      cell: (row) => (
        <span className={`tm-cc-pill${row.outcome === 'succeeded' ? '' : ' tm-cc-pill--muted'}`}>
          {row.outcome}
          {row.reason ? ` · ${row.reason}` : ''}
        </span>
      ),
    },
    { id: 'ip', header: t('PlatformActivity.colIp'), kind: 'mono', cell: (row) => row.ip ?? '—' },
    { id: 'device', header: t('PlatformActivity.colDevice'), cell: (row) => row.userAgent ?? '—' },
  ];
  return (
    <div className="tm-stack">
      <div className="tm-cc-form__pair">
        <SearchField
          label={t('PlatformActivity.searchSignIns')}
          placeholder={t('PlatformActivity.searchSignInsPlaceholder')}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <Select
          label={t('PlatformActivity.colOutcome')}
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
        >
          <option value="">{t('PlatformActivity.any')}</option>
          <option value="succeeded">{t('PlatformActivity.outcomeSucceeded')}</option>
          <option value="failed">{t('PlatformActivity.outcomeFailed')}</option>
          <option value="locked">{t('PlatformActivity.outcomeLocked')}</option>
        </Select>
      </div>
      <ListState list={list} empty={rows.length === 0} />
      {list.isSuccess && rows.length > 0 ? (
        <PlatformTable
          label={t('PlatformActivity.viewSignIns')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      ) : null}
    </div>
  );
}

function Sessions({ api }: { api: ApiClient }) {
  const t = useT();
  const queryClient = useQueryClient();
  const permissions = usePlatformPermissions(api);
  const [q, setQ] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [ending, setEnding] = useState<PlatformLiveSessionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const search = useDebounced(q);
  const filter = { ...(search ? { q: search } : {}), active: activeOnly ? 'true' : 'false' };
  const list = useInfiniteQuery({
    queryKey: [...ACTIVITY_KEY, 'sessions', filter],
    queryFn: ({ pageParam }) => listPlatformLiveSessions(api, filter, pageParam || null),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.sessions) ?? [];
  const canEnd = permissions.has('platform.people.security');
  const columns: PlatformColumn<PlatformLiveSessionView>[] = [
    {
      id: 'who',
      header: t('PlatformActivity.colWho'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <Link className="tm-cc-cell-title" href={`/platform/people/${row.userId}`}>
            {row.displayName}
          </Link>
          <span className="tm-cc-cell-sub">
            {row.email}
            {row.isPlatformAdmin ? ` · ${t('PlatformActivity.platformAdminTag')}` : ''}
          </span>
        </div>
      ),
    },
    { id: 'device', header: t('PlatformActivity.colDevice'), cell: (row) => row.userAgent ?? '—' },
    {
      id: 'ip',
      header: t('PlatformActivity.colIp'),
      kind: 'mono',
      cell: (row) => row.ipLast ?? row.ipFirst ?? '—',
    },
    {
      id: 'started',
      header: t('PlatformActivity.colStarted'),
      cell: (row) => moment(row.createdAt),
    },
    {
      id: 'last',
      header: t('PlatformActivity.colLastActive'),
      cell: (row) => moment(row.lastActiveAt),
    },
    {
      id: 'end',
      header: '',
      cell: (row) =>
        row.active && canEnd ? (
          <Button type="button" tone="outline" onClick={() => setEnding(row)}>
            {t('PlatformActivity.endSession')}
          </Button>
        ) : row.active ? null : (
          <span className="tm-cc-pill tm-cc-pill--muted">{t('PlatformActivity.ended')}</span>
        ),
    },
  ];
  return (
    <div className="tm-stack">
      <div className="tm-cc-form__pair">
        <SearchField
          label={t('PlatformActivity.searchSessions')}
          placeholder={t('PlatformActivity.searchSessionsPlaceholder')}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <Checkbox
          label={t('PlatformActivity.activeOnly')}
          checked={activeOnly}
          onChange={(event) => setActiveOnly(event.target.checked)}
        />
      </div>
      {notice ? (
        <InlineAlert tone="success" live>
          {notice}
        </InlineAlert>
      ) : null}
      <ListState list={list} empty={rows.length === 0} />
      {list.isSuccess && rows.length > 0 ? (
        <PlatformTable
          label={t('PlatformActivity.viewSessions')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          isMuted={(row) => !row.active}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      ) : null}
      {ending ? (
        <ReasonDialog
          title={`${t('PlatformActivity.endSessionTitle')} ${ending.email}`}
          body={t('PlatformActivity.endSessionBody')}
          reasonRequired
          destructive
          confirmLabel={t('PlatformActivity.endSession')}
          onConfirm={(reason) => endPlatformSession(api, ending.id, reason ?? '')}
          onClose={(done) => {
            if (done) {
              setNotice(`${t('PlatformActivity.sessionEnded')} ${ending.email}`);
              void queryClient.invalidateQueries({ queryKey: [...ACTIVITY_KEY, 'sessions'] });
            }
            setEnding(null);
          }}
        />
      ) : null}
    </div>
  );
}

function StepUps({ api }: { api: ApiClient }) {
  const t = useT();
  const [kind, setKind] = useState('');
  const filter = kind ? { kind } : {};
  const list = useInfiniteQuery({
    queryKey: [...ACTIVITY_KEY, 'step-ups', filter],
    queryFn: ({ pageParam }) => listPlatformStepUps(api, filter, pageParam || null),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.stepUps) ?? [];
  const columns: PlatformColumn<PlatformStepUpView>[] = [
    { id: 'when', header: t('PlatformActivity.colWhen'), cell: (row) => moment(row.occurredAt) },
    {
      id: 'who',
      header: t('PlatformActivity.colWho'),
      cell: (row) => row.displayName ?? row.email ?? '—',
    },
    {
      id: 'kind',
      header: t('PlatformActivity.colKind'),
      cell: (row) =>
        row.kind === 'platform'
          ? t('PlatformActivity.stepUpPlatform')
          : t('PlatformActivity.stepUpMember'),
    },
    {
      id: 'outcome',
      header: t('PlatformActivity.colOutcome'),
      cell: (row) =>
        `${row.outcome}${row.mfaVerified ? ` · ${t('PlatformActivity.twoStep')}` : ''}`,
    },
    { id: 'ip', header: t('PlatformActivity.colIp'), kind: 'mono', cell: (row) => row.ip ?? '—' },
  ];
  return (
    <div className="tm-stack">
      <Select
        label={t('PlatformActivity.colKind')}
        value={kind}
        onChange={(event) => setKind(event.target.value)}
      >
        <option value="">{t('PlatformActivity.any')}</option>
        <option value="platform">{t('PlatformActivity.stepUpPlatform')}</option>
        <option value="member">{t('PlatformActivity.stepUpMember')}</option>
      </Select>
      <ListState list={list} empty={rows.length === 0} />
      {list.isSuccess && rows.length > 0 ? (
        <PlatformTable
          label={t('PlatformActivity.viewStepUps')}
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.kind}:${row.id}`}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      ) : null}
    </div>
  );
}

function Suspicious({ api }: { api: ApiClient }) {
  const t = useT();
  const [window, setWindow] = useState<PlatformSuspiciousView['window']>('24h');
  const view = useQuery({
    queryKey: [...ACTIVITY_KEY, 'suspicious', window],
    queryFn: () => fetchPlatformSuspicious(api, window),
  });
  return (
    <div className="tm-stack">
      <Select
        label={t('PlatformActivity.window')}
        value={window}
        onChange={(event) => setWindow(event.target.value as PlatformSuspiciousView['window'])}
      >
        <option value="1h">{t('PlatformActivity.window1h')}</option>
        <option value="24h">{t('PlatformActivity.window24h')}</option>
        <option value="7d">{t('PlatformActivity.window7d')}</option>
      </Select>
      {view.isPending ? <PlatformPageState state="loading" /> : null}
      {view.isError ? (
        <PlatformPageState state="error" error={view.error} onRetry={() => void view.refetch()} />
      ) : null}
      {view.isSuccess && view.data.patterns.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformActivity.noSuspiciousTitle')}
          body={t('PlatformActivity.noSuspiciousBody')}
        />
      ) : null}
      {view.isSuccess
        ? view.data.patterns.map((pattern) => (
            <section
              key={`${pattern.kind}:${pattern.source}`}
              className="tm-cc-card tm-cc-card--quiet"
            >
              <p className="tm-cc-eyebrow">
                {pattern.kind === 'ip_burst'
                  ? t('PlatformActivity.patternIpBurst')
                  : t('PlatformActivity.patternRepeated')}{' '}
                ·{' '}
                {pattern.status === 'locked'
                  ? t('PlatformActivity.patternLocked')
                  : t('PlatformActivity.patternOpen')}
              </p>
              <p className="tm-cc-cell-title tm-cc-cell-mono">{pattern.source}</p>
              <p className="tm-cc-cell-sub">
                {pattern.failures} {t('PlatformActivity.failures')} · {pattern.accountsHit}{' '}
                {t('PlatformActivity.accountsHit')} · {moment(pattern.firstAt)} –{' '}
                {moment(pattern.lastAt)}
              </p>
              <div className="tm-cc-card__actions">
                {pattern.userId ? (
                  <Link className="tm-cc-pill" href={`/platform/people/${pattern.userId}/security`}>
                    {t('PlatformActivity.openPerson')}
                  </Link>
                ) : null}
                {pattern.kind === 'ip_burst' ? (
                  <Link
                    className="tm-cc-pill"
                    href={filterHref('/platform/activity', { ip: pattern.source })}
                  >
                    {t('PlatformActivity.actionsFromIp')}
                  </Link>
                ) : null}
              </div>
            </section>
          ))
        : null}
      {view.isSuccess && !view.data.geoAvailable ? (
        <InlineAlert tone="neutral">{t('PlatformActivity.geoPlaceholder')}</InlineAlert>
      ) : null}
    </div>
  );
}

function ListState({
  list,
  empty,
}: {
  list: {
    isPending: boolean;
    isError: boolean;
    isSuccess: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  empty: boolean;
}) {
  const t = useT();
  if (list.isPending) return <PlatformPageState state="loading" />;
  if (list.isError) {
    return (
      <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
    );
  }
  if (list.isSuccess && empty) {
    return (
      <PlatformPageState
        state="empty"
        title={t('PlatformActivity.nothingHereTitle')}
        body={t('PlatformActivity.nothingHereBody')}
      />
    );
  }
  return null;
}
