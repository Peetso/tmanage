'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { apiBaseUrl, browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  contentDownloadUrl,
  deleteContentItem,
  editContentItem,
  fetchContentItem,
  isSupportSessionRequired,
  restoreContentItem,
} from '../../../lib/api/platform-content';
import type {
  ContentEditInput,
  PlatformContentHistoryView,
  PlatformContentItemView,
  PlatformContentVersionView,
} from '../../../lib/api/platform-content';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { formatBytes, formatMoment } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { platformErrorText, REASON_MAX, REASON_MIN, ReasonDialog } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ContentFrame, contentKey, DeletedNotice, kindLabel } from './content-kit';

/** B6 as its own route: `/platform/organizations/:id/content/:kind/:itemId`. */
export function PlatformContentItemScreen({
  client,
  organizationId,
  kind,
  itemId,
}: ScreenProps & { organizationId: string; kind: string; itemId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <ContentFrame
      api={api}
      organizationId={organizationId}
      crumb={kindLabel(kind, t)}
      title={(name) => `${t('PlatformContent.titlePrefix')} ${name}`}
    >
      {() => (
        <div className="tm-stack">
          <Link
            className="tm-cc-row-button tm-content-back"
            href={`/platform/organizations/${organizationId}/content`}
          >
            {t('PlatformContent.backToContent')}
          </Link>
          <ContentViewer api={api} organizationId={organizationId} kind={kind} itemId={itemId} />
        </div>
      )}
    </ContentFrame>
  );
}

const WORK_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'internal_review',
  'done',
] as const;

type EditField = 'body' | 'title' | 'description' | 'state' | 'dueAt' | 'rationale' | 'agendaNote';

const FIELD_KEYS: Record<EditField, MessageKey> = {
  body: 'PlatformContent.fieldBody',
  title: 'PlatformContent.fieldTitle',
  description: 'PlatformContent.fieldDescription',
  state: 'PlatformContent.fieldState',
  dueAt: 'PlatformContent.fieldDueAt',
  rationale: 'PlatformContent.fieldRationale',
  agendaNote: 'PlatformContent.fieldAgenda',
};

const MULTILINE: ReadonlySet<EditField> = new Set([
  'body',
  'description',
  'rationale',
  'agendaNote',
]);

/** The value each editable field starts from, read off the item view. */
function initialValue(view: PlatformContentItemView, field: EditField): string {
  switch (field) {
    case 'body':
      return view.body ?? '';
    case 'title':
      return view.item.title;
    case 'description':
    case 'agendaNote':
      return view.body ?? '';
    case 'state':
      return view.item.state ?? '';
    case 'dueAt':
      return view.item.dueAt ? view.item.dueAt.slice(0, 10) : '';
    case 'rationale':
      return '';
  }
}

function editableFields(view: PlatformContentItemView): EditField[] {
  return view.editable.filter((field): field is EditField => field in FIELD_KEYS);
}

/**
 * B6 viewer and moderation panel (436:20060 / 436:20401 / 436:20238): the item read-only, its
 * metadata strip, the moderation toolbar (Edit, Delete, Restore, History, Open in app), the edit
 * form with the unsaved-changes diff, the history with before → after, and the locked
 * explanation for an approved deliverable version.
 */
export function ContentViewer({
  api,
  organizationId,
  kind,
  itemId,
  onChanged,
}: {
  api: ApiClient;
  organizationId: string;
  kind: string;
  itemId: string;
  /** The browser refetches its list after a write. */
  onChanged?: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const canModerate = usePlatformPermissions(api).has('platform.content.moderate');
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [deleting, setDeleting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const key = contentKey(organizationId, 'item', kind, itemId);
  const item = useQuery({
    queryKey: key,
    queryFn: () => fetchContentItem(api, organizationId, kind, itemId),
    retry: false,
  });

  useEffect(() => {
    if (item.isError && isSupportSessionRequired(item.error)) {
      void queryClient.invalidateQueries({ queryKey: contentKey(organizationId, 'home') });
    }
  }, [item.isError, item.error, organizationId, queryClient]);

  useEffect(() => {
    setMode('read');
    setShowHistory(false);
  }, [kind, itemId]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: contentKey(organizationId) });
    onChanged?.();
  }

  const restore = useMutation({
    mutationFn: () => restoreContentItem(api, organizationId, kind, itemId),
    onSuccess: refresh,
  });

  if (item.isPending) return <PlatformPageState state="loading" />;
  if (item.isError) {
    return (
      <PlatformPageState state="error" error={item.error} onRetry={() => void item.refetch()} />
    );
  }

  const view = item.data;
  const row = view.item;
  const deleted = row.deletedAt !== null;
  const fields = editableFields(view);
  const canEdit = canModerate && fields.length > 0 && !deleted && view.locked === null;
  const canDelete = canModerate && !deleted && view.locked?.code !== 'version_locked';

  return (
    <article
      className="tm-cc-card tm-content-viewer"
      aria-label={row.title}
      data-testid="content-viewer"
    >
      <header className="tm-stack tm-stack--tight">
        <p className="tm-cc-eyebrow">{kindLabel(row.kind, t)}</p>
        <h2 className={deleted ? 'tm-cc-card__title tm-content-struck' : 'tm-cc-card__title'}>
          {row.title || t('PlatformContent.untitled')}
        </h2>
        <MetaStrip view={view} />
      </header>

      <div className="tm-content-toolbar" role="toolbar" aria-label={t('PlatformContent.toolbar')}>
        {canEdit && mode === 'read' ? (
          <Button type="button" tone="outline" size="compact" onClick={() => setMode('edit')}>
            {t('PlatformContent.edit')}
          </Button>
        ) : null}
        {canDelete ? (
          <Button type="button" tone="destructive" size="compact" onClick={() => setDeleting(true)}>
            {t('PlatformContent.delete')}
          </Button>
        ) : null}
        {deleted && canModerate ? (
          <Button
            type="button"
            tone="lime"
            size="compact"
            loading={restore.isPending}
            loadingLabel={t('PlatformShared.working')}
            onClick={() => restore.mutate()}
          >
            {t('PlatformContent.restore')}
          </Button>
        ) : null}
        <Button
          type="button"
          tone="text"
          size="compact"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((open) => !open)}
        >
          {t('PlatformContent.history')} · {view.history.length}
        </Button>
        {view.openInApp && !deleted ? (
          <Link className="tm-cc-row-button" href={view.openInApp}>
            {t('PlatformContent.openInApp')}
          </Link>
        ) : null}
        {row.kind === 'file' && !deleted ? (
          <a
            className="tm-cc-row-button"
            href={contentDownloadUrl(apiBaseUrl(), organizationId, row.id)}
            rel="noopener"
          >
            {t('PlatformContent.download')}
          </a>
        ) : null}
      </div>

      {restore.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(restore.error, t)}
        </InlineAlert>
      ) : null}

      <DeletedNotice row={row} canRestore={false} />
      {deleted && row.deletedReason ? (
        <p className="tm-cc-note">
          {t('PlatformContent.deleteReason')}: {row.deletedReason}
        </p>
      ) : null}

      {view.locked?.code === 'version_locked' ? <LockedNotice view={view} /> : null}
      {view.locked?.code === 'append_only' && !deleted ? (
        <InlineAlert tone="neutral">{t('PlatformContent.appendOnly')}</InlineAlert>
      ) : null}

      {mode === 'edit' ? (
        <EditForm
          api={api}
          organizationId={organizationId}
          view={view}
          fields={fields}
          onDone={async (saved) => {
            setMode('read');
            if (saved) await refresh();
          }}
        />
      ) : (
        <ContentBody view={view} />
      )}

      {view.deliverableVersions.length > 0 ? (
        <VersionsList versions={view.deliverableVersions} />
      ) : null}

      {showHistory ? <HistoryPanel history={view.history} /> : null}

      {deleting ? (
        <ReasonDialog
          eyebrow={t('PlatformContent.deleteEyebrow')}
          title={`${t('PlatformContent.deleteTitle')} ${kindLabel(row.kind, t).toLowerCase()}?`}
          body={
            <span className="tm-stack tm-stack--tight">
              <span className="tm-content-quote">
                {(view.body ?? row.title).slice(0, 280) || t('PlatformContent.untitled')}
              </span>
              <span>{t('PlatformContent.deleteBody')}</span>
            </span>
          }
          reasonRequired
          destructive
          confirmLabel={t('PlatformContent.deleteConfirm')}
          note={t('PlatformContent.deleteNote')}
          onConfirm={(reason) => deleteContentItem(api, organizationId, kind, itemId, reason ?? '')}
          onClose={(done) => {
            setDeleting(false);
            if (done) void refresh();
          }}
        />
      ) : null}
    </article>
  );
}

function MetaStrip({ view }: { view: PlatformContentItemView }) {
  const t = useT();
  const row = view.item;
  const parts: string[] = [];
  parts.push(`${t('PlatformContent.metaAuthor')} ${row.authorName ?? '—'}`);
  parts.push(`${t('PlatformContent.metaCreated')} ${formatMoment(row.createdAt)}`);
  if (row.edited || row.updatedAt) {
    parts.push(`${t('PlatformContent.metaEdited')} ${formatMoment(row.updatedAt)}`);
  }
  if (row.projectName) parts.push(`${t('PlatformContent.metaProject')} ${row.projectName}`);
  if (row.audience) parts.push(`${t('PlatformContent.metaAudience')} ${row.audience}`);
  if (row.state) parts.push(`${t('PlatformContent.metaState')} ${row.state}`);
  if (row.sizeBytes !== null) parts.push(formatBytes(row.sizeBytes));
  if (row.location) parts.push(`${t('PlatformContent.metaLocation')} ${row.location}`);
  if (row.scan) parts.push(`${t('PlatformContent.metaScan')} ${row.scan}`);
  if (view.version !== null) parts.push(`v${view.version}`);
  return (
    <p className="tm-cc-cell-mono tm-content-meta" data-testid="content-meta">
      {parts.join(' · ')}
    </p>
  );
}

/** Read mode: the text as text nodes only, one paragraph per blank-line block. */
function ContentBody({ view }: { view: PlatformContentItemView }) {
  const t = useT();
  const text = view.body;
  const deleted = view.item.deletedAt !== null;
  if (text === null || text.trim() === '') {
    return <p className="tm-cc-note">{t('PlatformContent.noBody')}</p>;
  }
  return (
    <div
      className={
        deleted ? 'tm-prose tm-content-body tm-content-struck' : 'tm-prose tm-content-body'
      }
    >
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

function LockedNotice({ view }: { view: PlatformContentItemView }) {
  const t = useT();
  const lock = view.locked;
  return (
    <InlineAlert tone="warning" title={t('PlatformContent.lockedTitle')}>
      <span data-testid="content-locked">
        {t('PlatformContent.lockedBody')}
        {lock?.approvedAt
          ? ` ${t('PlatformContent.lockedApproved')} ${formatMoment(lock.approvedAt)}${
              lock.approvedByName ? ` · ${lock.approvedByName}` : ''
            }.`
          : ''}
      </span>
    </InlineAlert>
  );
}

function VersionsList({ versions }: { versions: readonly PlatformContentVersionView[] }) {
  const t = useT();
  return (
    <section className="tm-stack tm-stack--tight" aria-label={t('PlatformContent.versions')}>
      <p className="tm-cc-eyebrow">{t('PlatformContent.versions')}</p>
      <ul className="tm-content-list">
        {versions.map((version) => (
          <li key={version.id} className="tm-content-version">
            <span className="tm-cc-cell-mono">v{version.versionNo}</span>
            <span>{version.fileName ?? version.deliverableTitle}</span>
            <span
              className={
                version.approvalState === 'approved'
                  ? 'tm-cc-pill tm-cc-pill--on'
                  : 'tm-cc-pill tm-cc-pill--muted'
              }
            >
              {version.approvalState ?? t('PlatformContent.notReviewed')}
            </span>
            <span className="tm-cc-cell-mono">
              {formatMoment(version.approvedAt ?? version.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HistoryPanel({ history }: { history: readonly PlatformContentHistoryView[] }) {
  const t = useT();
  if (history.length === 0) {
    return <p className="tm-cc-note">{t('PlatformContent.noHistory')}</p>;
  }
  return (
    <section
      className="tm-stack tm-stack--tight"
      aria-label={t('PlatformContent.history')}
      data-testid="content-history"
    >
      <p className="tm-cc-eyebrow">{t('PlatformContent.history')}</p>
      <ol className="tm-content-list">
        {history.map((event) => (
          <li key={event.id} className="tm-content-history">
            <div className="tm-content-history__head">
              <span className="tm-cc-cell-mono">{event.action}</span>
              {event.viaSupport ? (
                <span className="tm-cc-pill tm-cc-pill--danger">
                  {t('PlatformContent.viaSupport')}
                </span>
              ) : null}
              <span className="tm-cc-note">
                {event.actorName ?? '—'} · {formatMoment(event.at)}
              </span>
            </div>
            {event.changes.map((change) => (
              <p key={change.field} className="tm-content-change">
                <span className="tm-cc-cell-mono">{change.field}</span>{' '}
                {change.redacted ? (
                  t('PlatformContent.redacted')
                ) : (
                  <>
                    <del>{change.before ?? '∅'}</del> → <ins>{change.after ?? '∅'}</ins>
                  </>
                )}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}

function EditForm({
  api,
  organizationId,
  view,
  fields,
  onDone,
}: {
  api: ApiClient;
  organizationId: string;
  view: PlatformContentItemView;
  fields: readonly EditField[];
  onDone: (saved: boolean) => void | Promise<void>;
}) {
  const t = useT();
  const initial = Object.fromEntries(fields.map((f) => [f, initialValue(view, f)])) as Record<
    EditField,
    string
  >;
  const [values, setValues] = useState<Record<EditField, string>>(initial);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const changed = fields.filter((field) => values[field] !== initial[field]);
  const trimmed = reason.trim();
  const reasonInvalid =
    trimmed.length > 0 && (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX);

  const save = useMutation({
    mutationFn: () => {
      const input: Record<string, string | null> = {};
      for (const field of changed) {
        input[field] = field === 'dueAt' && values[field] === '' ? null : values[field];
      }
      if (trimmed !== '') input['reason'] = trimmed;
      return editContentItem(
        api,
        organizationId,
        view.item.kind,
        view.item.id,
        input as ContentEditInput,
      );
    },
    onSuccess: () => onDone(true),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (reasonInvalid || changed.length === 0) return;
    save.mutate();
  }

  return (
    <form
      className="tm-stack tm-content-edit"
      onSubmit={submit}
      noValidate
      data-testid="content-edit"
    >
      <p className="tm-cc-eyebrow tm-content-edit__eyebrow">
        {t('PlatformContent.editingAsSupport')}
      </p>
      {fields.map((field) =>
        field === 'state' ? (
          <Select
            key={field}
            label={t(FIELD_KEYS[field])}
            value={values[field]}
            onChange={(event) => setValues({ ...values, [field]: event.target.value })}
          >
            {WORK_STATES.map((state) => (
              <option key={state} value={state}>
                {state.replace('_', ' ')}
              </option>
            ))}
          </Select>
        ) : MULTILINE.has(field) ? (
          <label key={field} className="tm-content-textarea">
            <span className="tm-content-textarea__label">{t(FIELD_KEYS[field])}</span>
            <textarea
              value={values[field]}
              rows={field === 'body' ? 5 : 4}
              onChange={(event) => setValues({ ...values, [field]: event.target.value })}
            />
          </label>
        ) : (
          <Field
            key={field}
            label={t(FIELD_KEYS[field])}
            type={field === 'dueAt' ? 'date' : 'text'}
            value={values[field]}
            onChange={(event) => setValues({ ...values, [field]: event.target.value })}
          />
        ),
      )}
      {changed.length > 0 ? (
        <section className="tm-content-diff" aria-label={t('PlatformContent.unsaved')}>
          <p className="tm-cc-eyebrow">
            {t('PlatformContent.unsaved')} · {changed.length}
          </p>
          {changed.map((field) => (
            <p key={field} className="tm-content-change">
              <span className="tm-cc-cell-mono">{t(FIELD_KEYS[field])}</span>{' '}
              <del>{initial[field] || '∅'}</del> → <ins>{values[field] || '∅'}</ins>
            </p>
          ))}
        </section>
      ) : tried ? (
        <InlineAlert tone="neutral">{t('PlatformContent.nothingChanged')}</InlineAlert>
      ) : null}
      <Field
        label={t('PlatformShared.reasonOptional')}
        placeholder={t('PlatformShared.reasonPlaceholder')}
        value={reason}
        maxLength={REASON_MAX}
        onChange={(event) => setReason(event.target.value)}
        {...(tried && reasonInvalid ? { error: t('PlatformShared.reasonError') } : {})}
      />
      <InlineAlert tone="neutral">{t('PlatformContent.editNote')}</InlineAlert>
      {save.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(save.error, t)}
        </InlineAlert>
      ) : null}
      <div className="tm-cc-card__actions">
        <Button type="button" tone="outline" onClick={() => void onDone(false)}>
          {t('PlatformShared.cancel')}
        </Button>
        <Button
          type="submit"
          tone="ink"
          loading={save.isPending}
          loadingLabel={t('PlatformShared.working')}
        >
          {t('PlatformContent.saveChanges')}
        </Button>
      </div>
    </form>
  );
}
