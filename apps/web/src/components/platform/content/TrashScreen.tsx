'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  contentHomeHref,
  contentItemHref,
  fetchContentTrash,
  restoreContentItem,
} from '../../../lib/api/platform-content';
import type { PlatformContentRowView } from '../../../lib/api/platform-content';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { formatMoment } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { platformErrorText } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ContentFrame, contentKey, kindLabel } from './content-kit';

/** The kind filter: every kind, with the six comment tables as one `comment` group. */
const KIND_FILTERS = [
  'message',
  'direct_message',
  'work_item',
  'comment',
  'doc',
  'decision',
  'meeting',
  'file',
  'drive_file',
  'onedrive_file',
  'request_message',
] as const;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** B7 `/platform/organizations/:id/content/trash` — Deleted content (438:18424 / 438:18673). */
export function PlatformContentTrashScreen({
  client,
  organizationId,
}: ScreenProps & { organizationId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <ContentFrame
      api={api}
      organizationId={organizationId}
      crumb={t('PlatformContent.trashCrumb')}
      title={(name) => `${t('PlatformContent.trashTitle')} — ${name}`}
    >
      {(home) => <TrashBody api={api} organizationId={home.organization.id} />}
    </ContentFrame>
  );
}

function TrashBody({ api, organizationId }: { api: ApiClient; organizationId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const canModerate = usePlatformPermissions(api).has('platform.content.moderate');
  const [kind, setKind] = useState('');
  const [deletedBy, setDeletedBy] = useState('');
  const [supportOnly, setSupportOnly] = useState(false);
  const [purgingSoon, setPurgingSoon] = useState(false);
  const trash = useQuery({
    queryKey: contentKey(organizationId, 'trash', kind, supportOnly),
    queryFn: () => fetchContentTrash(api, organizationId, { kind, supportOnly }),
    retry: false,
  });
  const restore = useMutation({
    mutationFn: (row: PlatformContentRowView) =>
      restoreContentItem(api, organizationId, row.kind, row.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentKey(organizationId) });
    },
  });

  const deleters = useMemo(() => {
    const names = new Set<string>();
    for (const row of trash.data?.rows ?? []) if (row.authorName) names.add(row.authorName);
    return [...names].sort();
  }, [trash.data]);

  const now = Date.now();
  const rows = (trash.data?.rows ?? []).filter(
    (row) =>
      (deletedBy === '' || row.authorName === deletedBy) &&
      (!purgingSoon ||
        (row.purgeAfter !== null && new Date(row.purgeAfter).getTime() - now <= WEEK_MS)),
  );
  const filtered = kind !== '' || deletedBy !== '' || supportOnly || purgingSoon;

  function clearFilters() {
    setKind('');
    setDeletedBy('');
    setSupportOnly(false);
    setPurgingSoon(false);
  }

  const columns: PlatformColumn<PlatformContentRowView>[] = [
    {
      id: 'kind',
      header: t('PlatformContent.colKind'),
      cell: (row) => <span className="tm-cc-pill tm-cc-pill--muted">{kindLabel(row.kind, t)}</span>,
    },
    {
      id: 'title',
      header: t('PlatformContent.colTitle'),
      cell: (row) => (
        <Link className="tm-cc-cell-title" href={contentItemHref(organizationId, row.kind, row.id)}>
          {row.title || t('PlatformContent.untitled')}
        </Link>
      ),
    },
    {
      id: 'deletedBy',
      header: t('PlatformContent.colDeletedBy'),
      cell: (row) => (
        <span className="tm-cc-card__actions">
          <span>{row.authorName ?? '—'}</span>
          {row.deletedViaSupport ? (
            <span className="tm-cc-pill tm-cc-pill--danger">{t('PlatformContent.viaSupport')}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'when',
      header: t('PlatformContent.colWhen'),
      kind: 'mono',
      cell: (row) => formatMoment(row.deletedAt),
    },
    {
      id: 'purges',
      header: t('PlatformContent.colPurges'),
      kind: 'mono',
      cell: (row) => formatMoment(row.purgeAfter),
    },
    {
      id: 'actions',
      header: <span className="tm-visually-hidden">{t('PlatformContent.colActions')}</span>,
      cell: (row) =>
        canModerate ? (
          <Button
            type="button"
            tone="outline"
            size="compact"
            loading={restore.isPending && restore.variables?.id === row.id}
            loadingLabel={t('PlatformShared.working')}
            onClick={() => restore.mutate(row)}
          >
            {t('PlatformContent.restore')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="tm-stack" data-testid="content-trash">
      <div className="tm-content-filters tm-content-filters--inline">
        <Select
          label={t('PlatformContent.filterKind')}
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="">{t('PlatformContent.any')}</option>
          {KIND_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === 'comment' ? t('PlatformContent.kindComment') : kindLabel(value, t)}
            </option>
          ))}
        </Select>
        <Select
          label={t('PlatformContent.filterDeletedBy')}
          value={deletedBy}
          onChange={(event) => setDeletedBy(event.target.value)}
        >
          <option value="">{t('PlatformContent.anyone')}</option>
          {deleters.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <Checkbox
          label={t('PlatformContent.bySupportOnly')}
          checked={supportOnly}
          onChange={(event) => setSupportOnly(event.target.checked)}
        />
        <Checkbox
          label={t('PlatformContent.purgesWithinWeek')}
          checked={purgingSoon}
          onChange={(event) => setPurgingSoon(event.target.checked)}
        />
        <Link className="tm-cc-row-button" href={contentHomeHref(organizationId)}>
          {t('PlatformContent.backToContent')}
        </Link>
      </div>
      {trash.isPending ? <PlatformPageState state="loading" /> : null}
      {trash.isError ? (
        <PlatformPageState state="error" error={trash.error} onRetry={() => void trash.refetch()} />
      ) : null}
      {restore.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(restore.error, t)}
        </InlineAlert>
      ) : null}
      {trash.isSuccess && rows.length === 0 ? (
        <section className="tm-cc-card tm-stack" data-testid="content-trash-empty">
          <h2 className="tm-cc-card__title">{t('PlatformContent.trashEmptyTitle')}</h2>
          <p className="tm-cc-note">
            {t('PlatformContent.trashEmptyBody')} {trash.data.purgeDays} {t('PlatformContent.days')}
            .
          </p>
          {filtered ? (
            <div>
              <Button type="button" tone="outline" onClick={clearFilters}>
                {t('PlatformContent.showAllDeleted')}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
      {trash.isSuccess && rows.length > 0 ? (
        <PlatformTable
          label={t('PlatformContent.trashTitle')}
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.kind}:${row.id}`}
          footer={
            <span className="tm-cc-note">
              {t('PlatformContent.trashFooter')} {trash.data.purgeDays} {t('PlatformContent.days')}.
            </span>
          }
        />
      ) : null}
    </div>
  );
}
