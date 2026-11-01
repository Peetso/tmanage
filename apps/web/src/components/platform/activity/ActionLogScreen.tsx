'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, SearchField, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { listPlatformActions, requestPlatformExport } from '../../../lib/api/platform-activity';
import type { ActivityQuery, PlatformActionView } from '../../../lib/api/platform-activity';
import { useT } from '../../../lib/i18n/use-t';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ActionDetailDrawer } from './ActionDetailDrawer';
import {
  ACTIVITY_KEY,
  ActivityFrame,
  moment,
  readSavedFilters,
  writeSavedFilters,
} from './ActivityFrame';
import { appLocale } from '../../../lib/i18n/app-locale';

/** The filter keys C1 understands; the page passes any of them from the URL. */
export const ACTION_FILTER_KEYS = [
  'q',
  'organizationId',
  'actorUserId',
  'effectiveActorUserId',
  'supportSessionId',
  'actionFamily',
  'action',
  'objectType',
  'objectId',
  'result',
  'supportOnly',
  'hasChanges',
  'from',
  'to',
  'ip',
  'correlationId',
] as const;

const FAMILIES = [
  'task',
  'project',
  'document',
  'file',
  'member',
  'invitation',
  'role',
  'client',
  'request',
  'support',
  'settings',
] as const;

const SAVED_KEY = 'tm.platform.activity.savedFilters';
const LIVE_INTERVAL_MS = 10_000;

/**
 * C1 · Actions (platform-admin v2 · PA-09) — every organization's action log in one place: search,
 * filters, the totals line, keyset "Load more", a live tail (a 10-second poll), saved filters (this
 * browser only), CSV export, and C2 detail on a row.
 */
export function ActionLogScreen({
  client,
  initialFilter = {},
}: ScreenProps & { initialFilter?: ActivityQuery }) {
  const api = client ?? browserApiClient();
  return (
    <ActivityFrame api={api} tab="actions">
      {() => <ActionLogBody api={api} initialFilter={initialFilter} />}
    </ActivityFrame>
  );
}

function isoDay(day: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return undefined;
  const at = new Date(`${day}T00:00:00.000Z`);
  if (end) at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString();
}

function ActionLogBody({ api, initialFilter }: { api: ApiClient; initialFilter: ActivityQuery }) {
  const t = useT();
  const router = useRouter();
  const permissions = usePlatformPermissions(api);
  const [q, setQ] = useState(initialFilter['q'] ?? '');
  const [debounced, setDebounced] = useState(q);
  const [fixed] = useState<ActivityQuery>(initialFilter);
  const [organizationId, setOrganizationId] = useState(initialFilter['organizationId'] ?? '');
  const [family, setFamily] = useState(initialFilter['actionFamily'] ?? '');
  const [result, setResult] = useState(initialFilter['result'] ?? '');
  const [supportOnly, setSupportOnly] = useState(initialFilter['supportOnly'] === 'true');
  const [hasChanges, setHasChanges] = useState(initialFilter['hasChanges'] === 'true');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState<PlatformActionView | null>(null);
  const [saved, setSaved] = useState<Record<string, Record<string, string>>>({});
  const [saveName, setSaveName] = useState('');
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => setSaved(readSavedFilters(SAVED_KEY)), []);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const filter: Record<string, string> = {};
  for (const [key, value] of Object.entries(fixed)) if (value) filter[key] = value;
  const set = (key: string, value: string | undefined) => {
    if (value) filter[key] = value;
    else delete filter[key];
  };
  set('q', debounced);
  set('organizationId', organizationId.trim());
  set('actionFamily', family);
  set('result', result);
  set('supportOnly', supportOnly ? 'true' : undefined);
  set('hasChanges', hasChanges && organizationId.trim() ? 'true' : undefined);
  set('from', fromDay ? isoDay(fromDay, false) : fixed['from']);
  set('to', toDay ? isoDay(toDay, true) : fixed['to']);

  const list = useInfiniteQuery({
    queryKey: [...ACTIVITY_KEY, 'actions', filter],
    queryFn: ({ pageParam }) => listPlatformActions(api, filter, pageParam || null),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
  const rows = list.data?.pages.flatMap((page) => page.actions) ?? [];
  const first = list.data?.pages[0];

  function saveFilter() {
    const name = saveName.trim();
    if (name === '') return;
    const next = { ...saved, [name]: filter };
    setSaved(next);
    setSaveName('');
    writeSavedFilters(SAVED_KEY, next);
  }

  function applySaved(name: string) {
    const chosen = saved[name];
    if (!chosen) return;
    const params = new URLSearchParams(chosen).toString();
    router.push(params === '' ? '/platform/activity' : `/platform/activity?${params}`);
  }

  async function exportCsv() {
    setExportNotice(null);
    setExportError(null);
    try {
      await requestPlatformExport(api, { scope: 'actions', filter, reason: null });
      setExportNotice(t('PlatformActivity.exportQueued'));
    } catch {
      setExportError(t('PlatformActivity.exportFailed'));
    }
  }

  const showsOrigin = first?.showsOrigin ?? false;
  const columns: PlatformColumn<PlatformActionView>[] = [
    { id: 'when', header: t('PlatformActivity.colWhen'), cell: (row) => moment(row.occurredAt) },
    {
      id: 'org',
      header: t('PlatformActivity.colOrganization'),
      cell: (row) => row.organizationName,
    },
    {
      id: 'who',
      header: t('PlatformActivity.colWho'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-cell-title">
            {row.actorName ?? row.actorEmail ?? t('PlatformActivity.system')}
          </span>
          {row.supportSessionId ? (
            <span className="tm-cc-pill tm-cc-pill--client">
              {t('PlatformActivity.viaSupport')}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'action',
      header: t('PlatformActivity.colAction'),
      cell: (row) => (
        <button type="button" className="tm-cc-cell-title" onClick={() => setOpen(row)}>
          {row.actionLabel}
        </button>
      ),
    },
    {
      id: 'object',
      header: t('PlatformActivity.colObject'),
      kind: 'mono',
      cell: (row) => `${row.objectType}${row.objectId ? ` · ${row.objectId.slice(0, 8)}` : ''}`,
    },
    {
      id: 'result',
      header: t('PlatformActivity.colResult'),
      cell: (row) => (
        <span className={`tm-cc-pill${row.result === 'allowed' ? '' : ' tm-cc-pill--muted'}`}>
          {t(
            row.result === 'allowed'
              ? 'PlatformActivity.resultAllowed'
              : row.result === 'denied'
                ? 'PlatformActivity.resultDenied'
                : 'PlatformActivity.resultError',
          )}
        </span>
      ),
    },
    ...(showsOrigin
      ? [
          {
            id: 'ip',
            header: t('PlatformActivity.colIp'),
            kind: 'mono' as const,
            cell: (row: PlatformActionView) => row.ip ?? '—',
          },
        ]
      : []),
  ];

  return (
    <div className="tm-stack">
      {first ? (
        <p className="tm-cc-eyebrow">
          {first.totals.total.toLocaleString(appLocale())} {t('PlatformActivity.totalActions')} ·{' '}
          {first.totals.viaSupport.toLocaleString(appLocale())}{' '}
          {t('PlatformActivity.totalViaSupport')} ·{' '}
          {first.totals.denied.toLocaleString(appLocale())} {t('PlatformActivity.totalDenied')} ·{' '}
          {first.totals.errors.toLocaleString(appLocale())} {t('PlatformActivity.totalErrors')}
        </p>
      ) : null}
      <SearchField
        label={t('PlatformActivity.searchLabel')}
        placeholder={t('PlatformActivity.searchPlaceholder')}
        value={q}
        onChange={(event) => setQ(event.target.value)}
      />
      <div className="tm-cc-form__pair">
        <Field
          label={t('PlatformActivity.filterOrganization')}
          placeholder={t('PlatformActivity.filterOrganizationPlaceholder')}
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
        />
        <Select
          label={t('PlatformActivity.filterFamily')}
          value={family}
          onChange={(event) => setFamily(event.target.value)}
        >
          <option value="">{t('PlatformActivity.any')}</option>
          {FAMILIES.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </Select>
        <Select
          label={t('PlatformActivity.filterResult')}
          value={result}
          onChange={(event) => setResult(event.target.value)}
        >
          <option value="">{t('PlatformActivity.any')}</option>
          <option value="allowed">{t('PlatformActivity.resultAllowed')}</option>
          <option value="denied">{t('PlatformActivity.resultDenied')}</option>
          <option value="error">{t('PlatformActivity.resultError')}</option>
        </Select>
      </div>
      <div className="tm-cc-form__pair">
        <Field
          type="date"
          label={t('PlatformActivity.filterFrom')}
          value={fromDay}
          onChange={(event) => setFromDay(event.target.value)}
        />
        <Field
          type="date"
          label={t('PlatformActivity.filterTo')}
          value={toDay}
          onChange={(event) => setToDay(event.target.value)}
        />
      </div>
      <div className="tm-cc-card__actions">
        <Checkbox
          label={t('PlatformActivity.supportOnly')}
          checked={supportOnly}
          onChange={(event) => setSupportOnly(event.target.checked)}
        />
        <Checkbox
          label={t('PlatformActivity.hasChanges')}
          hint={organizationId.trim() ? undefined : t('PlatformActivity.hasChangesHint')}
          checked={hasChanges}
          disabled={!organizationId.trim()}
          onChange={(event) => setHasChanges(event.target.checked)}
        />
        <Checkbox
          label={t('PlatformActivity.liveTail')}
          checked={live}
          onChange={(event) => setLive(event.target.checked)}
        />
      </div>
      <div className="tm-cc-card__actions">
        {Object.keys(saved).length > 0 ? (
          <Select
            label={t('PlatformActivity.savedFilters')}
            value=""
            onChange={(event) => applySaved(event.target.value)}
          >
            <option value="">{t('PlatformActivity.chooseSaved')}</option>
            {Object.keys(saved).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        ) : null}
        <Field
          label={t('PlatformActivity.saveFilterName')}
          value={saveName}
          maxLength={60}
          onChange={(event) => setSaveName(event.target.value)}
        />
        <Button type="button" tone="outline" onClick={saveFilter} disabled={saveName.trim() === ''}>
          {t('PlatformActivity.saveFilter')}
        </Button>
        {permissions.has('platform.activity.export') ? (
          <Button type="button" tone="outline" onClick={() => void exportCsv()}>
            {t('PlatformActivity.exportCsv')}
          </Button>
        ) : null}
      </div>
      {exportNotice ? (
        <InlineAlert tone="success" live>
          {exportNotice}
        </InlineAlert>
      ) : null}
      {exportError ? (
        <InlineAlert tone="danger" live>
          {exportError}
        </InlineAlert>
      ) : null}
      {list.isPending ? <PlatformPageState state="loading" /> : null}
      {list.isError ? (
        <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.isSuccess && rows.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformActivity.noActionsTitle')}
          body={t('PlatformActivity.noActionsBody')}
        />
      ) : null}
      {list.isSuccess && rows.length > 0 ? (
        <PlatformTable
          label={t('PlatformActivity.actionsTitle')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      ) : null}
      {open ? (
        <ActionDetailDrawer
          api={api}
          organizationId={open.organizationId}
          eventId={open.id}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
