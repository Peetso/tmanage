'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Select } from '@tmanage/ui';
import { apiBaseUrl, browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  EXPORT_SCOPES,
  deletePlatformExport,
  listPlatformExports,
  platformExportDownloadPath,
  requestPlatformExport,
} from '../../../lib/api/platform-activity';
import type {
  PlatformExportJobView,
  PlatformExportScope,
  PlatformExportStatus,
} from '../../../lib/api/platform-activity';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { ReasonDialog, platformErrorText } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ACTIVITY_KEY, ActivityFrame, moment } from './ActivityFrame';
import { appLocale } from '../../../lib/i18n/app-locale';

/**
 * C6 · Exports (platform-admin v2 · PA-09) — CSV exports of the action log, sign-ins, sessions,
 * the platform admin log, organizations and people. Queued jobs run in the worker (sign-ins are
 * written at once); a ready file can be downloaded for 24 hours, then it expires. Requesting,
 * downloading and deleting are recorded. Progress is not tracked: "Running" has no percentage.
 */

const SCOPE_KEYS: Record<PlatformExportScope, MessageKey> = {
  actions: 'PlatformActivity.scopeActions',
  'sign-ins': 'PlatformActivity.scopeSignIns',
  sessions: 'PlatformActivity.scopeSessions',
  platform: 'PlatformActivity.scopePlatform',
  orgs: 'PlatformActivity.scopeOrgs',
  people: 'PlatformActivity.scopePeople',
};

const STATUS_KEYS: Record<PlatformExportStatus, MessageKey> = {
  queued: 'PlatformActivity.statusQueued',
  running: 'PlatformActivity.statusRunning',
  ready: 'PlatformActivity.statusReady',
  failed: 'PlatformActivity.statusFailed',
  expired: 'PlatformActivity.statusExpired',
};

const EXPORTS_KEY = [...ACTIVITY_KEY, 'exports'] as const;

export function ExportsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  return (
    <ActivityFrame api={api} tab="exports">
      {() => <ExportsBody api={api} />}
    </ActivityFrame>
  );
}

function ExportsBody({ api }: { api: ApiClient }) {
  const t = useT();
  const queryClient = useQueryClient();
  const permissions = usePlatformPermissions(api);
  const [scope, setScope] = useState<PlatformExportScope>('actions');
  const [deleting, setDeleting] = useState<PlatformExportJobView | null>(null);
  const list = useQuery({
    queryKey: EXPORTS_KEY,
    queryFn: () => listPlatformExports(api),
    // Queued and running jobs are polled until they settle.
    refetchInterval: (query) =>
      query.state.data?.exports.some((job) => job.status === 'queued' || job.status === 'running')
        ? 5_000
        : false,
  });
  const create = useMutation({
    mutationFn: () => requestPlatformExport(api, { scope, filter: {}, reason: null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPORTS_KEY }),
  });
  const canExport = permissions.has('platform.activity.export');

  const columns: PlatformColumn<PlatformExportJobView>[] = [
    {
      id: 'what',
      header: t('PlatformActivity.colExport'),
      cell: (row) => t(SCOPE_KEYS[row.scope]),
    },
    {
      id: 'filter',
      header: t('PlatformActivity.colFilter'),
      cell: (row) => {
        const parts = Object.entries(row.filter).map(([key, value]) => `${key}=${value}`);
        return <span className="tm-cc-cell-sub">{parts.length ? parts.join(' · ') : '—'}</span>;
      },
    },
    { id: 'by', header: t('PlatformActivity.colRequestedBy'), cell: (row) => row.requestedByEmail },
    { id: 'when', header: t('PlatformActivity.colWhen'), cell: (row) => moment(row.createdAt) },
    {
      id: 'status',
      header: t('PlatformActivity.colStatus'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <span
            className={`tm-cc-pill${row.status === 'ready' ? ' tm-cc-pill--on' : row.status === 'failed' || row.status === 'expired' ? ' tm-cc-pill--muted' : ''}`}
          >
            {t(STATUS_KEYS[row.status])}
            {row.rowCount !== null ? ` · ${row.rowCount.toLocaleString(appLocale())}` : ''}
          </span>
          {row.error ? <span className="tm-cc-cell-sub">{row.error}</span> : null}
          {row.status === 'ready' && row.expiresAt ? (
            <span className="tm-cc-cell-sub">
              {t('PlatformActivity.expires')} {moment(row.expiresAt)}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'do',
      header: '',
      cell: (row) => (
        <div className="tm-cc-card__actions">
          {row.status === 'ready' && canExport ? (
            <a
              className="tm-cc-pill"
              href={`${apiBaseUrl()}${platformExportDownloadPath(row.id)}`}
              download
            >
              {t('PlatformActivity.download')}
            </a>
          ) : null}
          {canExport ? (
            <Button type="button" tone="outline" onClick={() => setDeleting(row)}>
              {t('PlatformActivity.delete')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="tm-stack">
      {canExport ? (
        <section className="tm-cc-card" aria-label={t('PlatformActivity.newExport')}>
          <div className="tm-cc-card__actions">
            <Select
              label={t('PlatformActivity.newExport')}
              value={scope}
              onChange={(event) => setScope(event.target.value as PlatformExportScope)}
            >
              {EXPORT_SCOPES.map((id) => (
                <option key={id} value={id}>
                  {t(SCOPE_KEYS[id])}
                </option>
              ))}
            </Select>
            <Button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
              {t('PlatformActivity.runExport')}
            </Button>
          </div>
          <p className="tm-cc-note">{t('PlatformActivity.exportNote')}</p>
          {create.isError ? (
            <InlineAlert tone="danger" live>
              {platformErrorText(create.error, t)}
            </InlineAlert>
          ) : null}
        </section>
      ) : (
        <InlineAlert tone="neutral">{t('PlatformActivity.exportNeedsPermission')}</InlineAlert>
      )}
      {list.isPending ? <PlatformPageState state="loading" /> : null}
      {list.isError ? (
        <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.isSuccess && list.data.exports.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformActivity.noExportsTitle')}
          body={t('PlatformActivity.noExportsBody')}
        />
      ) : null}
      {list.isSuccess && list.data.exports.length > 0 ? (
        <PlatformTable
          label={t('PlatformActivity.exportsTitle')}
          columns={columns}
          rows={list.data.exports}
          rowKey={(row) => row.id}
          isMuted={(row) => row.status === 'expired'}
        />
      ) : null}
      {deleting ? (
        <ReasonDialog
          title={`${t('PlatformActivity.deleteExportTitle')} ${t(SCOPE_KEYS[deleting.scope])}`}
          body={t('PlatformActivity.deleteExportBody')}
          reasonRequired={false}
          destructive
          confirmLabel={t('PlatformActivity.delete')}
          onConfirm={(reason) => deletePlatformExport(api, deleting.id, reason)}
          onClose={(done) => {
            if (done) void queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
            setDeleting(null);
          }}
        />
      ) : null}
    </div>
  );
}
