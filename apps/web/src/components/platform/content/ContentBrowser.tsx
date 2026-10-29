'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, SearchField, Select } from '@tmanage/ui';
import { apiBaseUrl, browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  AREA_COUNT_KEY,
  CONTENT_AREAS,
  contentDownloadUrl,
  fetchContentList,
  fetchContentMessages,
  restoreContentItem,
} from '../../../lib/api/platform-content';
import type {
  ContentArea,
  PlatformContentHomeView,
  PlatformContentRowView,
} from '../../../lib/api/platform-content';
import type { MessageKey } from '../../../lib/i18n/t';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { formatBytes, formatMoment } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { platformErrorText } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ContentFrame, contentKey, DeletedNotice, kindLabel } from './content-kit';
import { ContentViewer } from './ContentViewer';

const AREA_KEYS: Record<ContentArea, MessageKey> = {
  chats: 'PlatformContent.areaChats',
  dms: 'PlatformContent.areaDms',
  work_items: 'PlatformContent.areaWorkItems',
  comments: 'PlatformContent.areaComments',
  docs: 'PlatformContent.areaDocs',
  decisions: 'PlatformContent.areaDecisions',
  meetings: 'PlatformContent.areaMeetings',
  files: 'PlatformContent.areaFiles',
  requests: 'PlatformContent.areaRequests',
};

/** The areas whose rows are conversations: the right column is their message stream. */
const STREAM_AREAS: Readonly<Partial<Record<ContentArea, 'channel' | 'dm' | 'request'>>> = {
  chats: 'channel',
  dms: 'dm',
  requests: 'request',
};

/** B5 `/platform/organizations/:id/content` — Content browser (436:16763). */
export function PlatformContentScreen({
  client,
  organizationId,
}: ScreenProps & { organizationId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <ContentFrame
      api={api}
      organizationId={organizationId}
      crumb={t('PlatformContent.crumbBrowse')}
      title={(name) => `${t('PlatformContent.titlePrefix')} ${name}`}
    >
      {(home) => <ContentBrowser api={api} home={home} />}
    </ContentFrame>
  );
}

interface Selection {
  readonly kind: string;
  readonly id: string;
}

export function ContentBrowser({ api, home }: { api: ApiClient; home: PlatformContentHomeView }) {
  const t = useT();
  const organizationId = home.organization.id;
  const [area, setArea] = useState<ContentArea>('chats');
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [author, setAuthor] = useState('');
  const [deletedOnly, setDeletedOnly] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);

  const list = useQuery({
    queryKey: contentKey(organizationId, 'list', area, q, deletedOnly),
    queryFn: () =>
      fetchContentList(api, organizationId, area, {
        q,
        deleted: deletedOnly ? 'only' : 'include',
      }),
    retry: false,
  });

  const rows = useMemo(
    () =>
      (list.data?.rows ?? []).filter(
        (row) =>
          (project === '' || row.projectId === project) &&
          (author === '' || row.authorUserId === author),
      ),
    [list.data, project, author],
  );
  const projects = uniqueBy(
    list.data?.rows ?? [],
    (r) => r.projectId,
    (r) => r.projectName,
  );
  const authors = uniqueBy(
    list.data?.rows ?? [],
    (r) => r.authorUserId,
    (r) => r.authorName,
  );

  function pickArea(next: ContentArea) {
    setArea(next);
    setSelected(null);
    setProject('');
    setAuthor('');
  }

  const stream = STREAM_AREAS[area];

  return (
    <div className="tm-content-browser" data-testid="content-browser">
      <nav className="tm-content-areas" aria-label={t('PlatformContent.areas')}>
        {CONTENT_AREAS.map((id) => (
          <button
            key={id}
            type="button"
            className={id === area ? 'tm-content-area tm-content-area--active' : 'tm-content-area'}
            aria-current={id === area ? 'page' : undefined}
            onClick={() => pickArea(id)}
          >
            <span>{t(AREA_KEYS[id])}</span>
            <span className="tm-cc-cell-mono">{home.counts[AREA_COUNT_KEY[id]]}</span>
          </button>
        ))}
      </nav>

      <section className="tm-content-pane" aria-label={t(AREA_KEYS[area])}>
        <div className="tm-content-filters">
          <SearchField
            label={t('PlatformContent.search')}
            placeholder={t('PlatformContent.searchPlaceholder')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <div className="tm-content-filters__row">
            <Select
              label={t('PlatformContent.filterProject')}
              value={project}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">{t('PlatformContent.any')}</option>
              {projects.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
            <Select
              label={t('PlatformContent.filterAuthor')}
              value={author}
              onChange={(event) => setAuthor(event.target.value)}
            >
              <option value="">{t('PlatformContent.any')}</option>
              {authors.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <Checkbox
            label={t('PlatformContent.deletedOnly')}
            checked={deletedOnly}
            onChange={(event) => setDeletedOnly(event.target.checked)}
          />
        </div>
        {list.isPending ? <PlatformPageState state="loading" /> : null}
        {list.isError ? (
          <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
        ) : null}
        {list.isSuccess && rows.length === 0 ? (
          <PlatformPageState
            state="empty"
            title={t('PlatformContent.emptyTitle')}
            body={t('PlatformContent.emptyBody')}
          />
        ) : null}
        {list.isSuccess && rows.length > 0 && area === 'files' ? (
          <FilesTable
            api={api}
            organizationId={organizationId}
            rows={rows}
            onDetails={(row) => setSelected({ kind: row.kind, id: row.id })}
          />
        ) : null}
        {list.isSuccess && rows.length > 0 && area !== 'files' ? (
          <RowList
            api={api}
            organizationId={organizationId}
            rows={rows}
            selectedId={selected?.id ?? null}
            onSelect={(row) => setSelected({ kind: row.kind, id: row.id })}
          />
        ) : null}
      </section>

      <section
        className="tm-content-pane tm-content-pane--viewer"
        aria-label={t('PlatformContent.viewer')}
      >
        {selected === null ? (
          <p className="tm-cc-note">{t('PlatformContent.pickSomething')}</p>
        ) : stream ? (
          // In Chats, DMs and Requests every row of the list is a conversation (or a request),
          // which the API tags with its messages' kind: it always opens as a message stream.
          <MessageStream
            api={api}
            organizationId={organizationId}
            kind={stream}
            conversationId={selected.id}
          />
        ) : (
          <ContentViewer
            api={api}
            organizationId={organizationId}
            kind={selected.kind}
            itemId={selected.id}
          />
        )}
      </section>
    </div>
  );
}

function uniqueBy(
  rows: readonly PlatformContentRowView[],
  id: (row: PlatformContentRowView) => string | null,
  name: (row: PlatformContentRowView) => string | null,
): [string, string][] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const key = id(row);
    if (key !== null && !seen.has(key)) seen.set(key, name(row) ?? key);
  }
  return [...seen.entries()];
}

function RowList({
  api,
  organizationId,
  rows,
  selectedId,
  onSelect,
}: {
  api: ApiClient;
  organizationId: string;
  rows: readonly PlatformContentRowView[];
  selectedId: string | null;
  onSelect: (row: PlatformContentRowView) => void;
}) {
  const t = useT();
  const canModerate = usePlatformPermissions(api).has('platform.content.moderate');
  const restore = useRestore(api, organizationId);
  return (
    <ul className="tm-content-rows" data-testid="content-rows">
      {rows.map((row) => (
        <li key={`${row.kind}:${row.id}`}>
          <button
            type="button"
            className={
              row.id === selectedId ? 'tm-content-row tm-content-row--active' : 'tm-content-row'
            }
            aria-current={row.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(row)}
          >
            <span
              className={row.deletedAt ? 'tm-cc-cell-title tm-content-struck' : 'tm-cc-cell-title'}
            >
              {row.title || t('PlatformContent.untitled')}
            </span>
            {row.preview && row.preview !== row.title ? (
              <span className={row.deletedAt ? 'tm-cc-note tm-content-struck' : 'tm-cc-note'}>
                {row.preview}
              </span>
            ) : null}
            <span className="tm-cc-cell-mono">
              {[
                kindLabel(row.kind, t),
                row.authorName,
                row.projectName,
                row.replies !== null && row.replies > 0
                  ? `${row.replies} ${t('PlatformContent.replies')}`
                  : null,
                formatMoment(row.updatedAt ?? row.createdAt),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </button>
          <DeletedNotice row={row} canRestore={canModerate} onRestore={() => restore.mutate(row)} />
        </li>
      ))}
      {restore.isError ? (
        <li>
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(restore.error, t)}
          </InlineAlert>
        </li>
      ) : null}
    </ul>
  );
}

function useRestore(api: ApiClient, organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (row: PlatformContentRowView) =>
      restoreContentItem(api, organizationId, row.kind, row.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentKey(organizationId) });
    },
  });
}

/** Chats / DMs / client requests: the conversation's messages, removed ones struck through. */
function MessageStream({
  api,
  organizationId,
  kind,
  conversationId,
}: {
  api: ApiClient;
  organizationId: string;
  kind: 'channel' | 'dm' | 'request';
  conversationId: string;
}) {
  const t = useT();
  const canModerate = usePlatformPermissions(api).has('platform.content.moderate');
  const restore = useRestore(api, organizationId);
  const [message, setMessage] = useState<PlatformContentRowView | null>(null);
  const messages = useQuery({
    queryKey: contentKey(organizationId, 'messages', kind, conversationId),
    queryFn: () => fetchContentMessages(api, organizationId, kind, conversationId),
    retry: false,
  });
  if (messages.isPending) return <PlatformPageState state="loading" />;
  if (messages.isError) {
    return (
      <PlatformPageState
        state="error"
        error={messages.error}
        onRetry={() => void messages.refetch()}
      />
    );
  }
  if (messages.data.messages.length === 0) {
    return <PlatformPageState state="empty" title={t('PlatformContent.noMessages')} />;
  }
  return (
    <div className="tm-stack">
      <ol className="tm-content-stream" data-testid="content-stream">
        {messages.data.messages.map((row) => (
          <li
            key={row.id}
            className={
              message?.id === row.id
                ? 'tm-content-message tm-content-message--active'
                : 'tm-content-message'
            }
          >
            <button
              type="button"
              className="tm-content-message__button"
              onClick={() => setMessage(row)}
            >
              <span className="tm-content-message__head">
                <span className="tm-cc-cell-title">{row.authorName ?? '—'}</span>
                <span className="tm-cc-cell-mono">{formatMoment(row.createdAt)}</span>
                {row.edited ? (
                  <span className="tm-cc-note">{t('PlatformContent.edited')}</span>
                ) : null}
              </span>
              <span
                className={
                  row.deletedAt
                    ? 'tm-content-message__body tm-content-struck'
                    : 'tm-content-message__body'
                }
              >
                {row.preview ?? row.title}
              </span>
              {row.replies !== null && row.replies > 0 ? (
                <span className="tm-cc-note">
                  {row.replies} {t('PlatformContent.replies')}
                </span>
              ) : null}
            </button>
            <DeletedNotice
              row={row}
              canRestore={canModerate}
              onRestore={() => restore.mutate(row)}
            />
          </li>
        ))}
      </ol>
      {message ? (
        <>
          <p className="tm-cc-cell-mono tm-content-footer" data-testid="content-selected-meta">
            {kindLabel(message.kind, t)} · {message.id} · {t('PlatformContent.metaAuthor')}{' '}
            {message.authorUserId ?? '—'}
            {message.sequenceNo !== null ? ` · #${message.sequenceNo}` : ''} ·{' '}
            {formatMoment(message.createdAt)}
          </p>
          <ContentViewer
            api={api}
            organizationId={organizationId}
            kind={message.kind}
            itemId={message.id}
            onChanged={() => void messages.refetch()}
          />
        </>
      ) : null}
    </div>
  );
}

/** Files: a metadata table (name, size, location, uploader, scan, versions) with Open, Details, Restore. */
function FilesTable({
  api,
  organizationId,
  rows,
  onDetails,
}: {
  api: ApiClient;
  organizationId: string;
  rows: readonly PlatformContentRowView[];
  onDetails: (row: PlatformContentRowView) => void;
}) {
  const t = useT();
  const canModerate = usePlatformPermissions(api).has('platform.content.moderate');
  const restore = useRestore(api, organizationId);
  const columns: PlatformColumn<PlatformContentRowView>[] = [
    {
      id: 'name',
      header: t('PlatformContent.colName'),
      cell: (row) => (
        <span className={row.deletedAt ? 'tm-cc-cell-title tm-content-struck' : 'tm-cc-cell-title'}>
          {row.title}
        </span>
      ),
    },
    {
      id: 'size',
      header: t('PlatformContent.colSize'),
      kind: 'mono',
      cell: (row) => (row.sizeBytes === null ? '—' : formatBytes(row.sizeBytes)),
    },
    {
      id: 'location',
      header: t('PlatformContent.colLocation'),
      cell: (row) => locationLabel(row.location, t),
    },
    {
      id: 'uploader',
      header: t('PlatformContent.colUploader'),
      cell: (row) => row.authorName ?? '—',
    },
    {
      id: 'scan',
      header: t('PlatformContent.colScan'),
      cell: (row) => <span className={scanPill(row.scan)}>{row.scan ?? '—'}</span>,
    },
    {
      id: 'versions',
      header: t('PlatformContent.colVersions'),
      kind: 'mono',
      cell: (row) => (row.versions === null ? '—' : `v${row.versions}`),
    },
    {
      id: 'actions',
      header: <span className="tm-visually-hidden">{t('PlatformContent.colActions')}</span>,
      cell: (row) => (
        <span className="tm-cc-card__actions">
          {row.kind === 'file' && row.deletedAt === null && row.scan === 'clean' ? (
            <a
              className="tm-cc-row-button"
              href={contentDownloadUrl(apiBaseUrl(), organizationId, row.id)}
              rel="noopener"
            >
              {t('PlatformContent.open')}
            </a>
          ) : null}
          <Button type="button" tone="text" size="compact" onClick={() => onDetails(row)}>
            {t('PlatformContent.details')}
          </Button>
          {row.deletedAt !== null && canModerate ? (
            <Button type="button" tone="text" size="compact" onClick={() => restore.mutate(row)}>
              {t('PlatformContent.restore')}
            </Button>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <div className="tm-stack tm-stack--tight">
      <PlatformTable
        label={t('PlatformContent.areaFiles')}
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.kind}:${row.id}`}
        isMuted={(row) => row.deletedAt !== null}
        footer={<span className="tm-cc-note">{t('PlatformContent.filesNote')}</span>}
      />
      {restore.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(restore.error, t)}
        </InlineAlert>
      ) : null}
    </div>
  );
}

function locationLabel(location: string | null, t: ReturnType<typeof useT>): string {
  if (location === 'google_drive') return t('PlatformContent.locationDrive');
  if (location === 'onedrive') return t('PlatformContent.locationOneDrive');
  if (location === 'local') return t('PlatformContent.locationLocal');
  return location ?? '—';
}

function scanPill(scan: string | null): string {
  if (scan === 'clean') return 'tm-cc-pill tm-cc-pill--on';
  if (scan === 'blocked') return 'tm-cc-pill tm-cc-pill--danger';
  if (scan === 'scanning' || scan === 'pending') return 'tm-cc-pill tm-cc-pill--warning';
  return 'tm-cc-pill tm-cc-pill--muted';
}
