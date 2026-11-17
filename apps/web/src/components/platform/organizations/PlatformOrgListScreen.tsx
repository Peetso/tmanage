'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, SearchField, Select, Tooltip } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import {
  createPlatformOrg,
  listPlatformOrgs,
  runPlatformOrgLifecycle,
} from '../../../lib/api/platform-organizations';
import type {
  PlatformOrgListQuery,
  PlatformOrgSummaryView,
} from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import {
  PlatformDialog,
  PlatformDialogActions,
  platformErrorText,
  ReasonDialog,
} from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ORGS_KEY, OrgHealth, OrgStatus, PlanChip, StorageBar, useRelative } from './org-kit';

const STATUSES: readonly {
  id: string;
  key: MessageKey;
  count: 'all' | 'active' | 'suspended' | 'deleted' | 'archived';
}[] = [
  { id: 'all', key: 'PlatformOrgs.chipAll', count: 'all' },
  { id: 'active', key: 'PlatformOrgs.statusActive', count: 'active' },
  { id: 'suspended', key: 'PlatformOrgs.statusSuspended', count: 'suspended' },
  { id: 'deleted', key: 'PlatformOrgs.statusDeleted', count: 'deleted' },
  { id: 'archived', key: 'PlatformOrgs.statusArchived', count: 'archived' },
];

const PLANS = ['free', 'starter', 'studio', 'business', 'enterprise'] as const;

/** A2 `/platform/organizations` — search, filter and open any organization (frame A2). */
export function PlatformOrgListScreen({
  client,
  startWithNew = false,
}: ScreenProps & { startWithNew?: boolean }) {
  const api = client ?? browserApiClient();
  const t = useT();
  const permissions = usePlatformPermissions(api);
  const [creating, setCreating] = useState(startWithNew);
  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[t('PlatformOrgs.listCrumb')]}
      title={t('PlatformOrgs.listTitle')}
      description={t('PlatformOrgs.listSubtitle')}
      actions={() => (
        <div className="tm-cc-hero__actions">
          <ExportCsvButton />
          {permissions.has('platform.orgs.edit') ? (
            <Button type="button" tone="ink" onClick={() => setCreating(true)}>
              {t('PlatformOrgs.newOrganization')}
            </Button>
          ) : null}
        </div>
      )}
    >
      {() => (
        <>
          <ListBody api={api} />
          {creating ? <NewOrganizationDialog api={api} onClose={() => setCreating(false)} /> : null}
        </>
      )}
    </PlatformGate>
  );
}

/** Export arrives with the Activity export (PA-09); until then the button explains itself. */
function ExportCsvButton() {
  const t = useT();
  return (
    <Tooltip content={t('PlatformOrgs.exportSoon')}>
      <Button type="button" tone="outline" disabled aria-disabled="true">
        {t('PlatformOrgs.exportCsv')}
      </Button>
    </Tooltip>
  );
}

function ListBody({ api }: { api: ApiClient }) {
  const t = useT();
  const relative = useRelative();
  const queryClient = useQueryClient();
  const permissions = usePlatformPermissions(api);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('all');
  const [plan, setPlan] = useState('any');
  const [health, setHealth] = useState('any');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<'suspension' | 'reactivation' | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const filters: PlatformOrgListQuery = {
    ...(debounced ? { q: debounced } : {}),
    ...(status !== 'all' ? { status } : {}),
    ...(plan !== 'any' ? { plan } : {}),
    ...(health !== 'any' ? { health } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: [...ORGS_KEY, 'list', filters],
    queryFn: ({ pageParam }) =>
      listPlatformOrgs(api, { ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.organizations) ?? [];
  const first = list.data?.pages[0];
  const columns: readonly PlatformColumn<PlatformOrgSummaryView>[] = [
    {
      id: 'org',
      header: t('PlatformOrgs.colOrganization'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <Link className="tm-cc-cell-title" href={`/platform/organizations/${row.id}`}>
            {row.name}
          </Link>
          <span className="tm-cc-cell-mono">{row.slug}</span>
        </div>
      ),
    },
    { id: 'owner', header: t('PlatformOrgs.colOwner'), cell: (row) => row.ownerEmail ?? '—' },
    {
      id: 'people',
      header: t('PlatformOrgs.colPeople'),
      kind: 'mono',
      cell: (row) => String(row.people),
    },
    { id: 'plan', header: t('PlatformOrgs.colPlan'), cell: (row) => <PlanChip plan={row.plan} /> },
    {
      id: 'storage',
      header: t('PlatformOrgs.colStorage'),
      cell: (row) => <StorageBar used={row.storageBytes} limit={row.storageLimitBytes} />,
    },
    {
      id: 'active',
      header: t('PlatformOrgs.colLastActive'),
      cell: (row) => relative(row.lastActiveAt),
    },
    {
      id: 'status',
      header: t('PlatformOrgs.colStatus'),
      cell: (row) => <OrgStatus status={row.status} />,
    },
    {
      id: 'health',
      header: t('PlatformOrgs.colHealth'),
      cell: (row) => <OrgHealth health={row.health} />,
    },
  ];
  const canAct = permissions.has('platform.orgs.lifecycle');
  return (
    <div className="tm-stack">
      {first ? (
        <p className="tm-cc-eyebrow">
          {first.counts.all} {t('PlatformOrgs.organizationsWord')} · {first.openSupportSessions}{' '}
          {t('PlatformOrgs.supportSessionsOpen')}
        </p>
      ) : null}
      <SearchField
        label={t('PlatformOrgs.searchLabel')}
        placeholder={t('PlatformOrgs.searchPlaceholder')}
        value={q}
        onChange={(event) => setQ(event.target.value)}
      />
      <div className="tm-chip-row" role="group" aria-label={t('PlatformOrgs.statusFilter')}>
        {STATUSES.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={status === chip.id ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={status === chip.id}
            onClick={() => setStatus(chip.id)}
          >
            {t(chip.key)} {first ? first.counts[chip.count] : ''}
          </button>
        ))}
        <Link className="tm-chip tm-chip--dashed" href="/platform/organizations/deleted">
          {t('PlatformOrgs.restoreWindowLink')}
        </Link>
      </div>
      <div className="tm-cc-form__pair">
        <Select
          label={t('PlatformOrgs.filterPlan')}
          value={plan}
          onChange={(event) => setPlan(event.target.value)}
        >
          <option value="any">{t('PlatformOrgs.any')}</option>
          {PLANS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </Select>
        <Select
          label={t('PlatformOrgs.filterHealth')}
          value={health}
          onChange={(event) => setHealth(event.target.value)}
        >
          <option value="any">{t('PlatformOrgs.any')}</option>
          <option value="good">{t('PlatformOrgs.healthGood')}</option>
          <option value="check">{t('PlatformOrgs.healthCheck')}</option>
          <option value="failing">{t('PlatformOrgs.healthFailing')}</option>
        </Select>
      </div>
      {list.isPending ? <PlatformPageState state="loading" /> : null}
      {list.isError ? (
        <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.isSuccess && rows.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformOrgs.noMatchesTitle')}
          body={t('PlatformOrgs.noMatchesBody')}
        />
      ) : null}
      {list.isSuccess && rows.length > 0 ? (
        <PlatformTable
          label={t('PlatformOrgs.listTitle')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          isMuted={(row) => row.status !== 'active'}
          {...(canAct
            ? {
                selected,
                onSelectedChange: setSelected,
                isSelectable: (row: PlatformOrgSummaryView) =>
                  row.status === 'active' || row.status === 'suspended',
                bulkActions: () => (
                  <>
                    <Button
                      type="button"
                      tone="destructive"
                      size="compact"
                      onClick={() => setBulk('suspension')}
                    >
                      {t('PlatformOrgs.suspend')}
                    </Button>
                    <Button
                      type="button"
                      tone="outline"
                      size="compact"
                      onClick={() => setBulk('reactivation')}
                    >
                      {t('PlatformOrgs.unsuspend')}
                    </Button>
                    <ExportCsvButton />
                  </>
                ),
              }
            : {})}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          footer={`${t('PlatformOrgs.showing')} ${rows.length} ${t('PlatformOrgs.of')} ${first?.counts.all ?? rows.length}`}
        />
      ) : null}
      {bulk ? (
        <ReasonDialog
          title={
            bulk === 'suspension'
              ? `${t('PlatformOrgs.suspend')} · ${selected.size}`
              : `${t('PlatformOrgs.unsuspend')} · ${selected.size}`
          }
          body={
            bulk === 'suspension' ? t('PlatformOrgs.suspendBody') : t('PlatformOrgs.unsuspendBody')
          }
          reasonRequired
          destructive={bulk === 'suspension'}
          confirmLabel={
            bulk === 'suspension' ? t('PlatformOrgs.suspend') : t('PlatformOrgs.unsuspend')
          }
          onConfirm={async (reason) => {
            const targets = rows.filter(
              (row) =>
                selected.has(row.id) &&
                (bulk === 'suspension' ? row.status === 'active' : row.status === 'suspended'),
            );
            for (const row of targets) {
              await runPlatformOrgLifecycle(api, row.id, bulk, { reason: reason ?? '' });
            }
          }}
          onClose={(done) => {
            setBulk(null);
            if (done) {
              setSelected(new Set());
              void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
            }
          }}
        />
      ) : null}
    </div>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 63);
}

/** The New organization dialog (frame A2 · new). */
function NewOrganizationDialog({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [plan, setPlan] = useState('');
  const create = useMutation({
    mutationFn: () =>
      createPlatformOrg(api, {
        name: name.trim(),
        slug,
        ownerEmail: ownerEmail.trim(),
        ...(plan ? { plan } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ORGS_KEY });
      onClose();
    },
  });
  const effectiveSlug = slugTouched ? slug : slugify(name);
  const fieldError = (field: string) =>
    create.error instanceof ApiRequestError
      ? create.error.details.find((d) => d.field === field)
      : undefined;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!slugTouched) setSlug(effectiveSlug);
    create.mutate();
  }
  return (
    <PlatformDialog title={t('PlatformOrgs.newOrganization')} onClose={onClose}>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <p className="tm-cc-note">{t('PlatformOrgs.newOrgBody')}</p>
        <Field
          label={t('PlatformOrgs.fieldOrgName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Field
          label={t('PlatformOrgs.fieldSlug')}
          hint={`tmanageapp.com/${effectiveSlug}`}
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
          {...(fieldError('slug')
            ? { error: create.error instanceof ApiRequestError ? create.error.message : '' }
            : {})}
          required
        />
        <Field
          label={t('PlatformOrgs.fieldOwnerEmail')}
          hint={t('PlatformOrgs.ownerEmailHint')}
          type="email"
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
          {...(fieldError('ownerEmail')
            ? { error: create.error instanceof ApiRequestError ? create.error.message : '' }
            : {})}
          required
        />
        <Select
          label={t('PlatformOrgs.fieldPlan')}
          hint={t('PlatformOrgs.planHint')}
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
        >
          <option value="">{t('PlatformOrgs.planBetaFree')}</option>
          {PLANS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </Select>
        <InlineAlert tone="neutral">{t('PlatformOrgs.newOrgAuditNote')}</InlineAlert>
        {create.isError && !fieldError('slug') && !fieldError('ownerEmail') ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(create.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
            {t('PlatformShared.cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            loading={create.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformOrgs.createOrganization')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
