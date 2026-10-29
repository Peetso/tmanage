'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  fetchDeletedPlatformOrgs,
  runPlatformOrgLifecycle,
} from '../../../lib/api/platform-organizations';
import type { PlatformOrgDeletedView } from '../../../lib/api/platform-organizations';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ConfirmActDialog, formatDay, formatGb, ORGS_KEY } from './org-kit';

type Row = PlatformOrgDeletedView['organizations'][number];

/** A9 `/platform/organizations/deleted` — the restore window (frame A9). */
export function PlatformDeletedOrgsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[t('PlatformOrgs.listCrumb'), t('PlatformOrgs.deletedCrumb')]}
      title={t('PlatformOrgs.deletedTitle')}
      description={t('PlatformOrgs.deletedSubtitle')}
    >
      {(me) => <DeletedBody api={api} me={me} />}
    </PlatformGate>
  );
}

function DeletedBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const permissions = usePlatformPermissions(api);
  const canAct = permissions.has('platform.orgs.lifecycle');
  const isSuper = me.preset === 'super_admin';
  const [acting, setActing] = useState<{ row: Row; act: 'restore' | 'purge' } | null>(null);
  const deleted = useQuery({
    queryKey: [...ORGS_KEY, 'deleted'],
    queryFn: () => fetchDeletedPlatformOrgs(api),
    retry: false,
  });
  const columns: readonly PlatformColumn<Row>[] = [
    {
      id: 'org',
      header: t('PlatformOrgs.colOrganization'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-cell-title">{row.name}</span>
          <span className="tm-cc-cell-mono">{row.slug}</span>
        </div>
      ),
    },
    { id: 'by', header: t('PlatformOrgs.colDeletedBy'), cell: (row) => row.deletedByEmail ?? '—' },
    { id: 'at', header: t('PlatformOrgs.colDeletedAt'), cell: (row) => formatDay(row.deletedAt) },
    {
      id: 'left',
      header: t('PlatformOrgs.colPurgeIn'),
      kind: 'mono',
      cell: (row) => t('PlatformOrgs.firstPurgeIn').replace('{days}', String(row.daysLeft)),
    },
    {
      id: 'storage',
      header: t('PlatformOrgs.colStorage'),
      kind: 'mono',
      cell: (row) => `${formatGb(row.storageBytes)} ${t('PlatformOrgs.gb')}`,
    },
    {
      id: 'actions',
      header: '',
      cell: (row) =>
        canAct ? (
          <div className="tm-cc-hero__actions">
            <Button
              type="button"
              tone="outline"
              size="compact"
              onClick={() => setActing({ row, act: 'restore' })}
            >
              {t('PlatformOrgs.restore')}
            </Button>
            {isSuper ? (
              <Button
                type="button"
                tone="destructive"
                size="compact"
                onClick={() => setActing({ row, act: 'purge' })}
              >
                {t('PlatformOrgs.purgeNow')}
              </Button>
            ) : null}
          </div>
        ) : null,
    },
  ];
  return (
    <div className="tm-cc-column">
      {deleted.isSuccess ? (
        <p className="tm-cc-note">
          {t('PlatformOrgs.purgeInfo').replace('{days}', String(deleted.data.retentionDays))}
        </p>
      ) : null}
      {deleted.isPending ? <PlatformPageState state="loading" /> : null}
      {deleted.isError ? (
        <PlatformPageState
          state="error"
          error={deleted.error}
          onRetry={() => void deleted.refetch()}
        />
      ) : null}
      {deleted.isSuccess && deleted.data.organizations.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformOrgs.noDeletedTitle')}
          body={t('PlatformOrgs.noDeletedBody')}
        />
      ) : null}
      {deleted.isSuccess && deleted.data.organizations.length > 0 ? (
        <PlatformTable
          label={t('PlatformOrgs.deletedTitle')}
          columns={columns}
          rows={deleted.data.organizations}
          rowKey={(row) => row.id}
        />
      ) : null}
      {acting ? (
        <ConfirmActDialog
          title={`${acting.act === 'restore' ? t('PlatformOrgs.restore') : t('PlatformOrgs.purgeNow')} · ${acting.row.name}`}
          body={
            acting.act === 'restore' ? t('PlatformOrgs.restoreBody') : t('PlatformOrgs.purgeBody')
          }
          slug={acting.row.slug}
          requireSlug={acting.act === 'purge'}
          destructive={acting.act === 'purge'}
          confirmLabel={
            acting.act === 'restore' ? t('PlatformOrgs.restore') : t('PlatformOrgs.purgeNow')
          }
          onConfirm={(input) => runPlatformOrgLifecycle(api, acting.row.id, acting.act, input)}
          onClose={(done) => {
            setActing(null);
            if (done) void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
          }}
        />
      ) : null}
    </div>
  );
}
