'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { listActivitySupportSessions } from '../../../lib/api/platform-activity';
import { endSupportSession, supportSessionActivityHref } from '../../../lib/api/platform-support';
import type { PlatformSupportSessionView } from '../../../lib/api/platform-support';
import { useT } from '../../../lib/i18n/use-t';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { ReasonDialog } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ACTIVITY_KEY, ActivityFrame, moment } from './ActivityFrame';

/**
 * C5 · Support sessions (platform-admin v2 · PA-09) — every Support visit, open ones first: who,
 * where, why, how long, how many actions; "End now" (PA-05's route, reason required) and "View
 * actions" (C1 filtered to the session).
 */
export function SupportSessionsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  return (
    <ActivityFrame api={api} tab="support">
      {() => <SupportSessionsBody api={api} />}
    </ActivityFrame>
  );
}

function SupportSessionsBody({ api }: { api: ApiClient }) {
  const t = useT();
  const queryClient = useQueryClient();
  const permissions = usePlatformPermissions(api);
  const [state, setState] = useState<'all' | 'open'>('all');
  const [ending, setEnding] = useState<PlatformSupportSessionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: [...ACTIVITY_KEY, 'support-sessions', state],
    queryFn: () => listActivitySupportSessions(api, { state }),
  });
  const canEnd = permissions.has('platform.orgs.enter');
  const columns: PlatformColumn<PlatformSupportSessionView>[] = [
    {
      id: 'admin',
      header: t('PlatformActivity.colAdmin'),
      cell: (row) => row.adminEmail,
    },
    {
      id: 'org',
      header: t('PlatformActivity.colOrganization'),
      cell: (row) => (
        <Link className="tm-cc-cell-title" href={`/platform/organizations/${row.organizationId}`}>
          {row.organizationName}
        </Link>
      ),
    },
    {
      id: 'reason',
      header: t('PlatformActivity.colReason'),
      cell: (row) => <span className="tm-cc-cell-sub">{row.reason ?? '—'}</span>,
    },
    {
      id: 'started',
      header: t('PlatformActivity.colStarted'),
      cell: (row) => moment(row.startedAt),
    },
    {
      id: 'ends',
      header: t('PlatformActivity.colEnds'),
      cell: (row) =>
        row.live ? (
          <span className="tm-cc-pill tm-cc-pill--on">
            {t('PlatformActivity.liveUntil')} {moment(row.expiresAt)}
          </span>
        ) : (
          <span className="tm-cc-pill tm-cc-pill--muted">
            {moment(row.endedAt ?? row.expiresAt)}
            {row.endedReason ? ` · ${row.endedReason}` : ''}
          </span>
        ),
    },
    {
      id: 'count',
      header: t('PlatformActivity.colActions'),
      kind: 'mono',
      cell: (row) => String(row.actionsCount),
    },
    {
      id: 'do',
      header: '',
      cell: (row) => (
        <div className="tm-cc-card__actions">
          <Link className="tm-cc-pill" href={supportSessionActivityHref(row.id)}>
            {t('PlatformActivity.viewActions')}
          </Link>
          {row.live && canEnd ? (
            <Button type="button" tone="destructive" onClick={() => setEnding(row)}>
              {t('PlatformActivity.endNow')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];
  return (
    <div className="tm-stack">
      <div className="tm-chip-row" role="group" aria-label={t('PlatformActivity.supportState')}>
        {(['all', 'open'] as const).map((id) => (
          <button
            key={id}
            type="button"
            className={state === id ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={state === id}
            onClick={() => setState(id)}
          >
            {id === 'all' ? t('PlatformActivity.supportAll') : t('PlatformActivity.supportOpen')}
            {id === 'open' && list.data ? ` ${String(list.data.openCount)}` : ''}
          </button>
        ))}
      </div>
      {notice ? (
        <InlineAlert tone="success" live>
          {notice}
        </InlineAlert>
      ) : null}
      {list.isPending ? <PlatformPageState state="loading" /> : null}
      {list.isError ? (
        <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.isSuccess && list.data.sessions.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformActivity.noSupportTitle')}
          body={t('PlatformActivity.noSupportBody')}
        />
      ) : null}
      {list.isSuccess && list.data.sessions.length > 0 ? (
        <PlatformTable
          label={t('PlatformActivity.supportTitle')}
          columns={columns}
          rows={list.data.sessions}
          rowKey={(row) => row.id}
          isMuted={(row) => !row.live}
        />
      ) : null}
      {ending ? (
        <ReasonDialog
          title={`${t('PlatformActivity.endSupportTitle')} ${ending.organizationName}`}
          body={t('PlatformActivity.endSupportBody')}
          reasonRequired
          destructive
          confirmLabel={t('PlatformActivity.endNow')}
          onConfirm={(reason) => endSupportSession(api, ending.id, reason)}
          onClose={(done) => {
            if (done) {
              setNotice(t('PlatformActivity.supportEnded'));
              void queryClient.invalidateQueries({
                queryKey: [...ACTIVITY_KEY, 'support-sessions'],
              });
            }
            setEnding(null);
          }}
        />
      ) : null}
    </div>
  );
}
