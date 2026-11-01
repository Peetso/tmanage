'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Avatar, Badge, Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { FilePreviewManifest } from '../../lib/api/file-preview';
import {
  deleteReviewComment,
  editReviewComment,
  replyToReviewThread,
  setReviewThreadResolved,
  sortThreadsForPanel,
  type ReviewComment,
  type ReviewThread,
} from '../../lib/api/review';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
import {
  CardPin,
  ThreadCard,
  personName,
  readableBody,
  useShortTime,
  useThreadMeta,
} from './ThreadCard';
import { useReviewDoor } from './review-door';
import { ThreadComposer, type ComposerSubmit } from './ThreadComposer';
import { ViewerIcon } from './viewer-icons';

export type ThreadFilter = 'all' | 'open' | 'resolved' | 'mine' | 'page';
export type PanelTab = 'comments' | 'versions' | 'details';

/** Whether the viewer started this thread (their first comment is theirs to delete). */
export function isMine(thread: ReviewThread): boolean {
  return thread.comments[0]?.canDelete === true;
}

export function filterThreads(
  threads: readonly ReviewThread[],
  filter: ThreadFilter,
  pageNo: number | null,
): readonly ReviewThread[] {
  const sorted = sortThreadsForPanel(threads);
  switch (filter) {
    case 'open':
      return sorted.filter((thread) => thread.status === 'open');
    case 'resolved':
      return sorted.filter((thread) => thread.status === 'resolved');
    case 'mine':
      return sorted.filter(isMine);
    case 'page':
      return sorted.filter((thread) => thread.pageNo === pageNo && thread.status === 'open');
    default:
      return sorted;
  }
}

export interface ThreadPanelProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly manifest: FilePreviewManifest;
  readonly threads: readonly ReviewThread[];
  readonly threadsLoading: boolean;
  readonly threadsError: unknown;
  readonly selectedThreadId: string | null;
  /** The PDF page on the stage (enables the "This page" filter), `null` for an image. */
  readonly pageNo: number | null;
  /** Whether the stage takes pins (an image or PDF on screen). */
  readonly stageAcceptsPins: boolean;
  readonly naturalSize: { readonly width: number; readonly height: number } | null;
  readonly onSelect: (threadId: string | null) => void;
  /** "Add comment" on a stage that takes pins: switch to the Pin tool. */
  readonly onStartPin: () => void;
  /** A comment with no pin (general), for files without a stage. */
  readonly onCreateGeneral: (input: ComposerSubmit) => void;
  readonly creatingGeneral: boolean;
  readonly createGeneralError: unknown;
  readonly onChanged: () => Promise<unknown>;
}

/**
 * The right rail (V-01 `Right rail`, 380 px; V-13/V-14): Comments · Versions · Details tabs.
 *
 * Comments lists the threads as a listbox (arrow keys move, Enter opens) with All / Open /
 * Resolved / Mine filters ("This page" on a PDF) and the "4 open · 2 resolved" counter. Opening a
 * thread shows its replies, the reply box, edit / delete on one's own replies and Resolve / Reopen.
 * On a phone the rail is the bottom sheet (CSS).
 */
export function ThreadPanel({
  api,
  organizationSlug,
  manifest,
  threads,
  threadsLoading,
  threadsError,
  selectedThreadId,
  pageNo,
  stageAcceptsPins,
  naturalSize,
  onSelect,
  onStartPin,
  onCreateGeneral,
  creatingGeneral,
  createGeneralError,
  onChanged,
}: ThreadPanelProps) {
  const t = useT();
  const { door, teamName } = useReviewDoor();
  const portal = door === 'portal';
  const describeError = useDescribeApiError();
  const id = useId();
  const [tab, setTab] = useState<PanelTab>('comments');
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const [active, setActive] = useState(0);
  const [writingGeneral, setWritingGeneral] = useState(false);

  const open = threads.filter((thread) => thread.status === 'open').length;
  const resolved = threads.length - open;
  const shown = filterThreads(threads, filter, pageNo);
  const selected = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const caps = manifest.capabilities;

  useEffect(() => {
    if (selectedThreadId) setTab('comments');
  }, [selectedThreadId]);

  useEffect(() => {
    if (!creatingGeneral && !createGeneralError) setWritingGeneral(false);
  }, [creatingGeneral, createGeneralError]);

  const counts: Record<ThreadFilter, number> = {
    all: threads.length,
    open,
    resolved,
    mine: threads.filter(isMine).length,
    page: threads.filter((thread) => thread.pageNo === pageNo && thread.status === 'open').length,
  };
  const filters: readonly ThreadFilter[] =
    pageNo !== null
      ? ['page', 'all', 'open', 'resolved', 'mine']
      : ['all', 'open', 'resolved', 'mine'];
  const filterLabel: Record<ThreadFilter, string> = {
    all: t('Viewer.filter.all'),
    open: t('Viewer.filter.open'),
    resolved: t('Viewer.filter.resolved'),
    mine: t('Viewer.filter.mine'),
    page: t('Viewer.filter.page'),
  };

  const optionId = (index: number) => `${id}-thread-${index}`;

  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    if (shown.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(shown.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(shown.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const thread = shown[Math.min(active, shown.length - 1)];
      if (thread) onSelect(thread.id);
    }
  }

  const versionCount = manifest.versions.versions.length;
  const tabs: readonly { id: PanelTab; label: string; count?: number }[] = [
    { id: 'comments', label: t('Viewer.tab.comments'), count: threads.length },
    { id: 'versions', label: t('Viewer.tab.versions'), count: versionCount },
    { id: 'details', label: t('Viewer.tab.details') },
  ];

  return (
    <aside className="tm-viewer-rail" aria-label={t('Viewer.rail.label')}>
      <div className="tm-viewer-rail__handle" aria-hidden="true" />
      {portal ? (
        <div className="tm-viewer-rail__title-row">
          <h2 id={`${id}-tab-comments`} className="tm-viewer-rail__title">
            {t('Viewer.tab.comments')}
          </h2>
        </div>
      ) : null}
      {portal ? null : (
        <div className="tm-viewer-tabs" role="tablist" aria-label={t('Viewer.rail.tabs')}>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${id}-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`${id}-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className="tm-viewer-tabs__tab"
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                const order = tabs.map((entry) => entry.id);
                const index = order.indexOf(item.id);
                const rtl = document.documentElement.dir === 'rtl';
                const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
                const back = rtl ? 'ArrowRight' : 'ArrowLeft';
                if (event.key !== forward && event.key !== back) return;
                event.preventDefault();
                const next =
                  order[(index + (event.key === forward ? 1 : order.length - 1)) % order.length]!;
                setTab(next);
                document.getElementById(`${id}-tab-${next}`)?.focus();
              }}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className="tm-viewer-tabs__count">{item.count}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      <div
        role={portal ? 'region' : 'tabpanel'}
        id={`${id}-panel-${tab}`}
        aria-labelledby={`${id}-tab-${tab}`}
        className="tm-viewer-rail__body"
      >
        {tab === 'comments' ? (
          selected ? (
            <ThreadDetail
              key={selected.id}
              api={api}
              organizationSlug={organizationSlug}
              projectId={manifest.file.projectId}
              thread={selected}
              canComment={caps.canComment}
              onBack={() => onSelect(null)}
              onChanged={onChanged}
            />
          ) : (
            <>
              <div className="tm-viewer-rail__summary">
                <span className="tm-viewer-counter">
                  {t('Viewer.counter')
                    .replace('{open}', String(open))
                    .replace('{resolved}', String(resolved))}
                </span>
              </div>
              <div className="tm-viewer-chips" role="group" aria-label={t('Viewer.filter.label')}>
                {filters.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="tm-viewer-chip"
                    aria-pressed={filter === value}
                    onClick={() => {
                      setFilter(value);
                      setActive(0);
                    }}
                  >
                    {filterLabel[value]}
                    <span className="tm-viewer-chip__count">{counts[value]}</span>
                  </button>
                ))}
              </div>

              {threadsError ? (
                <InlineAlert tone="danger" title={t('Viewer.threads.loadError')} live>
                  {describeError(threadsError)}
                </InlineAlert>
              ) : null}

              {threadsLoading ? (
                <p className="tm-viewer-rail__note">{t('Viewer.threads.loading')}</p>
              ) : shown.length === 0 && !threadsError ? (
                <div className="tm-viewer-empty">
                  <p className="tm-viewer-empty__title">
                    {threads.length === 0
                      ? t('Viewer.threads.emptyTitle')
                      : t('Viewer.threads.noneHere')}
                  </p>
                  {threads.length === 0 ? (
                    <p className="tm-viewer-rail__note">
                      {stageAcceptsPins && caps.canComment
                        ? t('Viewer.threads.emptyBody')
                        : t('Viewer.threads.emptyBodyGeneral')}
                    </p>
                  ) : null}
                </div>
              ) : (
                <ul
                  className="tm-viewer-list"
                  role="listbox"
                  aria-label={t('Viewer.threads.label')}
                  // The listbox is one tab stop; the arrow keys move between threads inside it.
                  tabIndex={0}
                  aria-activedescendant={optionId(Math.min(active, shown.length - 1))}
                  onKeyDown={onListKey}
                >
                  {shown.map((thread, index) => (
                    <ThreadCard
                      key={thread.id}
                      thread={thread}
                      selected={thread.id === selectedThreadId}
                      optionId={optionId(index)}
                      active={index === active}
                      onOpen={(threadId) => {
                        setActive(index);
                        onSelect(threadId);
                      }}
                    />
                  ))}
                </ul>
              )}

              {caps.canComment ? (
                <div className="tm-viewer-rail__foot">
                  {writingGeneral ? (
                    <ThreadComposer
                      api={api}
                      organizationSlug={organizationSlug}
                      projectId={manifest.file.projectId}
                      label={t('Viewer.composer.newLabel')}
                      submitLabel={t('Viewer.composer.post')}
                      pendingLabel={t('Viewer.composer.posting')}
                      audience={portal ? 'client_visible' : 'internal'}
                      canChooseAudience={!portal}
                      pending={creatingGeneral}
                      focusOnOpen
                      error={
                        createGeneralError ? (
                          <InlineAlert tone="danger" title={t('Viewer.composer.postError')} live>
                            {describeError(createGeneralError)}
                          </InlineAlert>
                        ) : null
                      }
                      onSubmit={onCreateGeneral}
                      onCancel={() => setWritingGeneral(false)}
                    />
                  ) : (
                    <>
                      <p className="tm-viewer-rail__note">
                        {stageAcceptsPins
                          ? t('Viewer.rail.hintPins')
                          : t('Viewer.rail.hintGeneral')}
                      </p>
                      <Button
                        type="button"
                        tone="ink"
                        size="accessible"
                        className="tm-viewer-rail__add"
                        onClick={() => (stageAcceptsPins ? onStartPin() : setWritingGeneral(true))}
                      >
                        <ViewerIcon name={stageAcceptsPins ? 'pin' : 'comment'} />
                        {t('Viewer.rail.addComment')}
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
              {portal ? (
                <p className="tm-viewer-rail__note tm-viewer-rail__note--team">
                  {t('Viewer.portal.railNote').replace(
                    '{team}',
                    teamName || t('Viewer.portal.teamFallback'),
                  )}
                </p>
              ) : null}
            </>
          )
        ) : tab === 'versions' ? (
          <VersionsList manifest={manifest} organizationSlug={organizationSlug} />
        ) : (
          <DetailsList manifest={manifest} naturalSize={naturalSize} />
        )}
      </div>
    </aside>
  );
}

function VersionsList({
  manifest,
  organizationSlug,
}: {
  manifest: FilePreviewManifest;
  organizationSlug: string;
}) {
  const t = useT();
  const format = useDisplayFormatters();
  return (
    <ol className="tm-viewer-versions">
      {manifest.versions.versions.map((version) => {
        const here = version.fileAssetId === manifest.file.id;
        return (
          <li
            key={version.fileAssetId}
            className="tm-viewer-versions__item"
            data-here={here ? 'true' : undefined}
          >
            <Badge mono>
              {t('Viewer.version.short').replace('{no}', String(version.versionNo))}
            </Badge>
            <span className="tm-viewer-versions__name">
              {here ? (
                <span aria-current="page">{version.fileName}</span>
              ) : (
                <Link
                  href={`/${organizationSlug}/files/${encodeURIComponent(version.fileAssetId)}`}
                >
                  {version.fileName}
                </Link>
              )}
              <span className="tm-viewer-versions__date">{format.day(version.createdAt)}</span>
            </span>
            {version.current ? <Badge>{t('Viewer.version.latest')}</Badge> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Bytes in the largest whole unit (KB / MB / GB), one decimal place. */
export function formatBytes(bytes: number, format: (value: number) => string): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${format(unit === 0 ? value : Math.round(value * 10) / 10)} ${units[unit]}`;
}

function DetailsList({
  manifest,
  naturalSize,
}: {
  manifest: FilePreviewManifest;
  naturalSize: { readonly width: number; readonly height: number } | null;
}) {
  const t = useT();
  const format = useDisplayFormatters();
  const current = manifest.versions.versions.find((v) => v.fileAssetId === manifest.file.id);
  const scan = manifest.version?.scanStatus;
  const rows: { label: string; value: string }[] = [
    { label: t('Viewer.details.name'), value: manifest.file.name },
  ];
  if (manifest.version?.mimeType) {
    rows.push({ label: t('Viewer.details.type'), value: manifest.version.mimeType });
  }
  if (manifest.version) {
    rows.push({
      label: t('Viewer.details.size'),
      value: formatBytes(manifest.version.sizeBytes, (n) => format.number(n)),
    });
  }
  if (current) {
    rows.push({
      label: t('Viewer.details.version'),
      value: t('Viewer.version.short').replace('{no}', String(current.versionNo)),
    });
    rows.push({ label: t('Viewer.details.uploaded'), value: format.day(current.createdAt) });
  }
  if (naturalSize && manifest.kind !== 'pdf') {
    rows.push({
      label: t('Viewer.details.dimensions'),
      value: t('Viewer.details.dimensionsValue')
        .replace('{width}', format.number(Math.round(naturalSize.width)))
        .replace('{height}', format.number(Math.round(naturalSize.height))),
    });
  }
  if (manifest.pages) {
    rows.push({ label: t('Viewer.details.pages'), value: format.number(manifest.pages) });
  }
  if (scan) rows.push({ label: t('Viewer.details.check'), value: t(`Viewer.scan.${scan}`) });
  return (
    <dl className="tm-viewer-details">
      {rows.map((row) => (
        <div key={row.label} className="tm-viewer-details__row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface ThreadDetailProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly projectId: string;
  readonly thread: ReviewThread;
  readonly canComment: boolean;
  readonly onBack: () => void;
  readonly onChanged: () => Promise<unknown>;
}

/** V-14 — one thread open in the rail. */
function ThreadDetail({
  api,
  organizationSlug,
  projectId,
  thread,
  canComment,
  onBack,
  onChanged,
}: ThreadDetailProps) {
  const t = useT();
  const { door } = useReviewDoor();
  const describeError = useDescribeApiError();
  const meta = useThreadMeta();
  const [editing, setEditing] = useState<string | null>(null);
  const [replyKey, setReplyKey] = useState(0);

  const reply = useMutation({
    mutationFn: (input: ComposerSubmit) =>
      replyToReviewThread(
        api,
        organizationSlug,
        thread.id,
        { body: input.body, mentions: input.mentions },
        door,
      ),
    onSuccess: async () => {
      setReplyKey((key) => key + 1);
      await onChanged();
    },
  });
  const resolve = useMutation({
    mutationFn: (resolved: boolean) =>
      setReviewThreadResolved(api, organizationSlug, thread.id, resolved, door),
    onSuccess: () => onChanged(),
  });
  const edit = useMutation({
    mutationFn: (input: { commentId: string } & ComposerSubmit) =>
      editReviewComment(
        api,
        organizationSlug,
        input.commentId,
        { body: input.body, mentions: input.mentions },
        door,
      ),
    onSuccess: async () => {
      setEditing(null);
      await onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: (commentId: string) => deleteReviewComment(api, organizationSlug, commentId, door),
    onSuccess: () => onChanged(),
  });

  const error = reply.error ?? resolve.error ?? edit.error ?? remove.error;

  return (
    <section className="tm-viewer-detail" aria-labelledby={`tm-viewer-thread-${thread.id}`}>
      <div className="tm-viewer-detail__top">
        <button type="button" className="tm-viewer-link" onClick={onBack}>
          <ViewerIcon name="back" className="tm-viewer-icon--flip" />
          {t('Viewer.thread.back')}
        </button>
      </div>
      <div className="tm-viewer-detail__head">
        <CardPin thread={thread} selected />
        <h2 id={`tm-viewer-thread-${thread.id}`} className="tm-viewer-detail__title">
          {t('Viewer.thread.title').replace('{number}', String(thread.number))}
        </h2>
        {door === 'portal' ? null : thread.audience === 'internal' ? (
          <Badge>{t('Viewer.audience.internal')}</Badge>
        ) : (
          <Badge tone="client">{t('Viewer.audience.client')}</Badge>
        )}
      </div>
      <p className="tm-viewer-card__meta">{meta(thread)}</p>
      {thread.carriedFromThreadId ? (
        <p className="tm-viewer-rail__note">{t('Viewer.thread.carried')}</p>
      ) : null}

      <ol className="tm-viewer-detail__comments">
        {thread.comments.map((comment) =>
          editing === comment.id ? (
            <li key={comment.id}>
              <ThreadComposer
                api={api}
                organizationSlug={organizationSlug}
                projectId={projectId}
                label={t('Viewer.composer.editLabel')}
                submitLabel={t('Viewer.composer.save')}
                pendingLabel={t('Viewer.composer.saving')}
                audience={thread.audience}
                canChooseAudience={false}
                initialBody={comment.body}
                pending={edit.isPending}
                focusOnOpen
                onSubmit={(input) => edit.mutate({ commentId: comment.id, ...input })}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <CommentRow
              key={comment.id}
              comment={comment}
              deleting={remove.isPending && remove.variables === comment.id}
              onEdit={() => setEditing(comment.id)}
              onDelete={() => remove.mutate(comment.id)}
            />
          ),
        )}
      </ol>

      {error ? (
        <InlineAlert tone="danger" title={t('Viewer.thread.actionError')} live>
          {describeError(error)}
        </InlineAlert>
      ) : null}

      {thread.status === 'resolved' && thread.resolvedBy ? (
        <p className="tm-viewer-rail__note">
          {t('Viewer.thread.resolvedBy').replace(
            '{name}',
            personName(thread.resolvedBy, t('Viewer.person.former')),
          )}
        </p>
      ) : null}

      <div className="tm-viewer-detail__foot">
        {canComment && thread.status === 'open' ? (
          <ThreadComposer
            key={replyKey}
            api={api}
            organizationSlug={organizationSlug}
            projectId={projectId}
            label={t('Viewer.composer.replyLabel')}
            submitLabel={t('Viewer.composer.reply')}
            pendingLabel={t('Viewer.composer.posting')}
            audience={thread.audience}
            canChooseAudience={false}
            pending={reply.isPending}
            onSubmit={(input) => reply.mutate(input)}
          />
        ) : null}
        {thread.canResolve ? (
          <Button
            type="button"
            tone="outline"
            size="compact"
            loading={resolve.isPending}
            loadingLabel={t('Viewer.thread.working')}
            onClick={() => resolve.mutate(thread.status === 'open')}
          >
            {thread.status === 'open' ? (
              <>
                <ViewerIcon name="check" />
                {t('Viewer.thread.resolve')}
              </>
            ) : (
              t('Viewer.thread.reopen')
            )}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function CommentRow({
  comment,
  deleting,
  onEdit,
  onDelete,
}: {
  comment: ReviewComment;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const shortTime = useShortTime();
  const name = personName(comment.author, t('Viewer.person.former'));
  return (
    <li className="tm-viewer-comment">
      <div className="tm-viewer-card__head">
        <Avatar
          name={name}
          audience={comment.author.kind === 'client' ? 'client' : 'internal'}
          size="compact"
          decorative
        />
        <span className="tm-viewer-card__name">{name}</span>
        <span className="tm-viewer-card__time">
          {shortTime(comment.createdAt)}
          {comment.editedAt ? ` · ${t('Viewer.comment.edited')}` : ''}
        </span>
      </div>
      <p className="tm-viewer-comment__body">
        {readableBody(comment.body, t('Viewer.person.someone'))}
      </p>
      {comment.canEdit || comment.canDelete ? (
        <div className="tm-viewer-comment__own">
          {comment.canEdit ? (
            <button type="button" className="tm-viewer-link" onClick={onEdit}>
              {t('Viewer.comment.edit')}
            </button>
          ) : null}
          {comment.canDelete ? (
            <button
              type="button"
              className="tm-viewer-link tm-viewer-link--danger"
              onClick={onDelete}
              disabled={deleting}
            >
              {t('Viewer.comment.delete')}
            </button>
          ) : null}
          {comment.canEdit ? (
            <span className="tm-viewer-rail__note">{t('Viewer.comment.editWindow')}</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
