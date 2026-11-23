'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, InlineAlert, SearchField } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  listPlatformAdminActions,
  requestPlatformExport,
} from '../../../lib/api/platform-activity';
import type { ActivityQuery, PlatformAdminActionView } from '../../../lib/api/platform-activity';
import { useT } from '../../../lib/i18n/use-t';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ACTIVITY_KEY, ActivityFrame, moment } from './ActivityFrame';
import { appIntlLocale } from '../../../lib/i18n/app-locale';

/**
 * C4 · Platform admins (platform-admin v2 · PA-09) — what the operators did, with their reasons
 * (`platform_admin_audit_events`). Before/after, IP and device show only with
 * `platform.activity.detail`. Replaces the PA-02 audit screen; `/platform/audit` redirects here.
 */
export function PlatformActionsScreen({
  client,
  initialFilter = {},
}: ScreenProps & { initialFilter?: ActivityQuery }) {
  const api = client ?? browserApiClient();
  return (
    <ActivityFrame api={api} tab="platform">
      {() => <PlatformActionsBody api={api} initialFilter={initialFilter} />}
    </ActivityFrame>
  );
}

function PlatformActionsBody({
  api,
  initialFilter,
}: {
  api: ApiClient;
  initialFilter: ActivityQuery;
}) {
  const t = useT();
  const permissions = usePlatformPermissions(api);
  const [q, setQ] = useState(initialFilter['q'] ?? '');
  const [debounced, setDebounced] = useState(q);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const filter: Record<string, string> = {};
  for (const [key, value] of Object.entries(initialFilter)) if (value) filter[key] = value;
  if (debounced) filter['q'] = debounced;
  else delete filter['q'];

  const list = useInfiniteQuery({
    queryKey: [...ACTIVITY_KEY, 'platform', filter],
    queryFn: ({ pageParam }) => listPlatformAdminActions(api, filter, pageParam || null),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.actions) ?? [];
  const first = list.data?.pages[0];

  const columns: PlatformColumn<PlatformAdminActionView>[] = [
    { id: 'when', header: t('PlatformActivity.colWhen'), cell: (row) => moment(row.occurredAt) },
    { id: 'admin', header: t('PlatformActivity.colAdmin'), cell: (row) => row.actorEmail },
    {
      id: 'action',
      header: t('PlatformActivity.colAction'),
      kind: 'mono',
      cell: (row) => row.action,
    },
    {
      id: 'target',
      header: t('PlatformActivity.colTarget'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <span>{row.targetLabel ?? row.targetType}</span>
          {row.organizationId ? (
            <Link className="tm-cc-cell-sub" href={`/platform/organizations/${row.organizationId}`}>
              {row.organizationName ?? row.organizationId}
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      id: 'reason',
      header: t('PlatformActivity.colReason'),
      cell: (row) => <span className="tm-cc-cell-sub">{row.reason ?? '—'}</span>,
    },
    {
      id: 'more',
      header: '',
      cell: (row) =>
        row.beforeJson !== null || row.afterJson !== null || row.ip !== null ? (
          <Button
            type="button"
            tone="outline"
            aria-expanded={expanded === row.id}
            onClick={() => setExpanded(expanded === row.id ? null : row.id)}
          >
            {expanded === row.id
              ? t('PlatformActivity.hideDetail')
              : t('PlatformActivity.showDetail')}
          </Button>
        ) : null,
    },
  ];
  const open = rows.find((row) => row.id === expanded);

  return (
    <div className="tm-stack">
      {first ? (
        <p className="tm-cc-eyebrow">
          {first.total.toLocaleString(appIntlLocale())} {t('PlatformActivity.totalPlatformActions')}
        </p>
      ) : null}
      <div className="tm-cc-card__actions">
        <SearchField
          label={t('PlatformActivity.searchPlatform')}
          placeholder={t('PlatformActivity.searchPlatformPlaceholder')}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        {permissions.has('platform.activity.export') ? (
          <Button
            type="button"
            tone="outline"
            onClick={() =>
              void requestPlatformExport(api, { scope: 'platform', filter, reason: null }).then(
                () => setNotice(t('PlatformActivity.exportQueued')),
                () => setNotice(t('PlatformActivity.exportFailed')),
              )
            }
          >
            {t('PlatformActivity.exportCsv')}
          </Button>
        ) : null}
      </div>
      {notice ? (
        <InlineAlert tone="neutral" live>
          {notice}
        </InlineAlert>
      ) : null}
      {list.isPending ? <PlatformPageState state="loading" /> : null}
      {list.isError ? (
        <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.isSuccess && rows.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformActivity.noPlatformTitle')}
          body={t('PlatformActivity.noPlatformBody')}
        />
      ) : null}
      {list.isSuccess && rows.length > 0 ? (
        <PlatformTable
          label={t('PlatformActivity.platformTitle')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      ) : null}
      {open ? (
        <section
          className="tm-cc-card tm-cc-card--quiet"
          aria-label={t('PlatformActivity.detailTitle')}
        >
          <p className="tm-cc-eyebrow">
            {open.action} · {moment(open.occurredAt)}
          </p>
          <dl className="tm-stack tm-stack--tight">
            <div>
              <dt className="tm-cc-cell-sub">{t('PlatformActivity.colBefore')}</dt>
              <dd className="tm-cc-cell-mono">{open.beforeJson ?? '—'}</dd>
            </div>
            <div>
              <dt className="tm-cc-cell-sub">{t('PlatformActivity.colAfter')}</dt>
              <dd className="tm-cc-cell-mono">{open.afterJson ?? '—'}</dd>
            </div>
            <div>
              <dt className="tm-cc-cell-sub">{t('PlatformActivity.colIp')}</dt>
              <dd className="tm-cc-cell-mono">{open.ip ?? '—'}</dd>
            </div>
            <div>
              <dt className="tm-cc-cell-sub">{t('PlatformActivity.colDevice')}</dt>
              <dd>{open.userAgent ?? '—'}</dd>
            </div>
            <div>
              <dt className="tm-cc-cell-sub">{t('PlatformActivity.correlationId')}</dt>
              <dd className="tm-cc-cell-mono">{open.correlationId}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
