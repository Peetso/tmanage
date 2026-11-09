'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addDocumentComment,
  listDocumentComments,
  resolveDocumentComment,
  unresolveDocumentComment,
} from '../../lib/api/document-comments';
import type { DocumentCommentView } from '../../lib/api/document-comments';
import { ApiRequestError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { initialsOf } from '../docs/DocumentAudience';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appDateLocale, appLocale } from '../../lib/i18n/app-locale';
import type { AnchorState } from '../docs/editor/comment-reanchor';
import '../docs/doc-history-panel.css';

export interface DocumentCommentsPanelProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
  /** R5: the anchor the body has selected; its thread is highlighted and scrolled into view. */
  activeAnchorId?: string | null;
  /** R5: a thread was picked in the rail — the body highlights and scrolls to its mark. */
  onCommentClick?: (anchorId: string) => void;
  /**
   * 53-11: where each thread's anchor stands after edits — `moved` (re-anchored to the nearest
   * text) or `lost` (the text was removed; the thread stays here). Absent = still on its mark.
   */
  anchorStates?: Readonly<Record<string, AnchorState>>;
}

/** One anchored thread: the first comment carries the quote and the resolved state. */
interface Thread {
  readonly anchorId: string;
  readonly quote: string | null;
  readonly root: DocumentCommentView;
  readonly comments: readonly DocumentCommentView[];
}

function threadsOf(rows: readonly DocumentCommentView[]): {
  readonly threads: readonly Thread[];
  readonly general: readonly DocumentCommentView[];
} {
  const byAnchor = new Map<string, DocumentCommentView[]>();
  const general: DocumentCommentView[] = [];
  for (const row of rows) {
    if (!row.anchorId) general.push(row);
    else byAnchor.set(row.anchorId, [...(byAnchor.get(row.anchorId) ?? []), row]);
  }
  const threads = [...byAnchor.entries()].map(([anchorId, comments]) => ({
    anchorId,
    quote: comments.find((c) => c.anchorQuote)?.anchorQuote ?? null,
    root: comments[0]!,
    comments,
  }));
  return { threads, general };
}

/**
 * **Docs comments rail — R5 frame 7 (Figma 486:29212) and its empty state 7b (486:29424).**
 *
 * Comments hang on selected text: each `anchorId` (a `mark[data-comment]` in the body) is one
 * thread showing its quote, its comments oldest-first, a reply field and Resolve / Reopen. Comments
 * without an anchor sit under "General" with the add form. "Show resolved" brings resolved threads
 * back. A thread click raises `onCommentClick` so the body scrolls to and highlights its mark; a mark
 * click comes back as `activeAnchorId` and scrolls the thread into view.
 *
 * The 404 "not available" posture of x132 is unchanged: unknown, cross-tenant and non-member ids
 * answer the same 404 and read as a quiet note, never an error. Comments are internal.
 */
export function DocumentCommentsPanel({
  organizationSlug,
  documentId,
  client,
  activeAnchorId = null,
  onCommentClick,
  anchorStates = {},
}: DocumentCommentsPanelProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const queryKey = ['document-comments', organizationSlug, documentId];

  const comments = useQuery({
    queryKey,
    queryFn: () => listDocumentComments(api, organizationSlug, documentId),
  });

  const [draft, setDraft] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const add = useMutation({
    mutationFn: () => addDocumentComment(api, organizationSlug, documentId, draft.trim()),
    onSuccess: async () => {
      setDraft('');
      await refresh();
    },
  });

  const reply = useMutation({
    mutationFn: (thread: Thread) =>
      addDocumentComment(
        api,
        organizationSlug,
        documentId,
        (replies[thread.anchorId] ?? '').trim(),
        { anchorId: thread.anchorId, anchorQuote: thread.quote ?? '' },
      ),
    onSuccess: async (_made, thread) => {
      setReplies((current) => ({ ...current, [thread.anchorId]: '' }));
      await refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: ({ commentId, resolve }: { commentId: string; resolve: boolean }) =>
      (resolve ? resolveDocumentComment : unresolveDocumentComment)(
        api,
        organizationSlug,
        documentId,
        commentId,
      ),
    onSuccess: refresh,
  });

  const notAvailable =
    comments.isError && comments.error instanceof ApiRequestError && comments.error.status === 404;

  const rows = useMemo(() => comments.data ?? [], [comments.data]);
  const { threads, general } = useMemo(() => threadsOf(rows), [rows]);
  const visible = threads.filter((thread) => showResolved || !thread.root.resolvedAt);
  const canAdd = draft.trim() !== '';

  // Mark → thread: bring the active thread into view in the rail.
  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (!activeAnchorId) return;
    const card = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-anchor]') ?? [],
    ).find((element) => element.getAttribute('data-anchor') === activeAnchorId);
    card?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [activeAnchorId]);

  const loaded = !comments.isPending && !comments.isError;

  return (
    <section className="tm-dx-edge tm-doc-rail" aria-labelledby="tm-document-comments">
      <div className="tm-doc-rail__head">
        <h2 id="tm-document-comments" className="tm-doc-rail__title">
          {t('DocumentCommentsPanel.comments')}
          {loaded ? ` · ${rows.length}` : ''}
        </h2>
        <Switch
          label={t('DocComments.showResolved')}
          checked={showResolved}
          onChange={(event) => setShowResolved(event.target.checked)}
        />
      </div>
      <p className="tm-dx-edge__caption">{t('DocumentCommentsPanel.internalOnly')}</p>

      {comments.isPending ? (
        <LoadingRegion label={t('DocumentCommentsPanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notAvailable ? (
        <InlineAlert tone="neutral" title={t('DocumentCommentsPanel.unavailableTitle')} live>
          {t('DocumentCommentsPanel.unavailableBody')}
        </InlineAlert>
      ) : null}

      {comments.isError && !notAvailable ? (
        <InlineAlert tone="danger" title={t('DocumentCommentsPanel.loadError')} live>
          {describeError(comments.error)}
        </InlineAlert>
      ) : null}

      {toggle.isError || reply.isError ? (
        <InlineAlert tone="danger" title={t('DocComments.actionError')} live>
          {describeError(toggle.error ?? reply.error)}
        </InlineAlert>
      ) : null}

      {loaded && rows.length === 0 ? (
        <div className="tm-doc-rail__empty">
          <p className="tm-doc-rail__empty-title">{t('DocumentCommentsPanel.empty')}</p>
          <p className="tm-dx-quiet">{t('DocComments.emptyHint')}</p>
        </div>
      ) : null}

      {loaded && visible.length > 0 ? (
        <ol ref={listRef} className="tm-doc-threads" aria-label={t('DocComments.threadsAria')}>
          {visible.map((thread) => {
            const resolved = Boolean(thread.root.resolvedAt);
            const active = thread.anchorId === activeAnchorId;
            const anchorState = anchorStates[thread.anchorId];
            return (
              <li
                key={thread.anchorId}
                data-anchor={thread.anchorId}
                className={`tm-doc-thread${active ? ' is-active' : ''}${resolved ? ' is-resolved' : ''}`}
              >
                <button
                  type="button"
                  className="tm-doc-thread__quote"
                  dir="auto"
                  aria-pressed={active}
                  onClick={() => onCommentClick?.(thread.anchorId)}
                >
                  <span
                    style={anchorState === 'lost' ? { textDecoration: 'line-through' } : undefined}
                  >
                    {thread.quote ? `“${thread.quote}”` : t('DocComments.selectedText')}
                  </span>
                </button>
                {anchorState === 'moved' ? (
                  <div className="tm-doc-thread__actions">
                    <Badge mono>{tOr('DocComments.anchorMoved', 'Moved to nearest text')}</Badge>
                  </div>
                ) : null}
                {anchorState === 'lost' ? (
                  <div className="tm-stack">
                    <div className="tm-doc-thread__actions">
                      <Badge mono>{tOr('DocComments.anchorLost', 'Text removed')}</Badge>
                    </div>
                    <p className="tm-dx-quiet">
                      {tOr(
                        'DocComments.anchorLostHint',
                        'The text this comment was on was removed. The discussion stays here.',
                      )}
                    </p>
                  </div>
                ) : null}
                {thread.comments.map((comment) => (
                  <CommentRow key={comment.id} comment={comment} />
                ))}
                {resolved ? (
                  <div className="tm-doc-thread__actions">
                    <Badge mono>{t('DocComments.resolved')}</Badge>
                    <Button
                      tone="outline"
                      size="compact"
                      loading={toggle.isPending && toggle.variables?.commentId === thread.root.id}
                      onClick={() => toggle.mutate({ commentId: thread.root.id, resolve: false })}
                    >
                      {t('DocComments.reopen')}
                    </Button>
                  </div>
                ) : (
                  <form
                    className="tm-doc-thread__reply"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      if ((replies[thread.anchorId] ?? '').trim() !== '') reply.mutate(thread);
                    }}
                  >
                    <input
                      className="tm-field__control"
                      dir="auto"
                      aria-label={t('DocComments.replyLabel')}
                      placeholder={t('DocComments.replyPlaceholder')}
                      value={replies[thread.anchorId] ?? ''}
                      onChange={(event) =>
                        setReplies((current) => ({
                          ...current,
                          [thread.anchorId]: event.target.value,
                        }))
                      }
                    />
                    <div className="tm-doc-thread__actions">
                      <Button
                        type="submit"
                        tone="outline"
                        size="compact"
                        disabled={(replies[thread.anchorId] ?? '').trim() === ''}
                      >
                        {t('DocComments.reply')}
                      </Button>
                      <Button
                        tone="ink"
                        size="compact"
                        loading={toggle.isPending && toggle.variables?.commentId === thread.root.id}
                        onClick={() => toggle.mutate({ commentId: thread.root.id, resolve: true })}
                      >
                        {t('DocComments.resolve')}
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}

      {loaded && general.length > 0 ? (
        <section className="tm-doc-rail__general" aria-labelledby="tm-document-comments-general">
          <h3 id="tm-document-comments-general" className="tm-dx-edge__caption">
            {t('DocComments.general')}
          </h3>
          <ol className="tm-dx-comments" aria-label={t('DocumentCommentsPanel.listAria')}>
            {general.map((comment) => (
              <li key={comment.id} className="tm-dx-comment">
                <CommentRow comment={comment} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <p className="tm-dx-edge__note tm-dx-edge__foot">
        <span className="tm-dx-edge__note-orb" aria-hidden="true">
          ◎
        </span>
        {t('DocumentCommentsPanel.footNote')}
      </p>

      <form
        className="tm-dx-comment-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canAdd) add.mutate();
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-document-comment-body">
            {t('DocumentCommentsPanel.addLabel')}
          </label>
          <textarea
            id="tm-document-comment-body"
            name="body"
            dir="auto"
            className="tm-field__control tm-field__control--multiline"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>

        {add.isError ? (
          <InlineAlert tone="danger" title={t('DocumentCommentsPanel.addError')} live>
            {describeError(add.error)}
          </InlineAlert>
        ) : null}

        <Button
          type="submit"
          tone="ink"
          size="compact"
          loading={add.isPending}
          loadingLabel={t('DocumentCommentsPanel.adding')}
          disabled={!canAdd}
        >
          {t('DocumentCommentsPanel.addComment')}
        </Button>
      </form>
    </section>
  );
}

/** Author orb, name, time and body of one comment. */
function CommentRow({ comment }: { comment: DocumentCommentView }) {
  const t = useT();
  return (
    <>
      <div className="tm-dx-comment__head">
        <span className="tm-dx-comment__orb" aria-hidden="true">
          {comment.authorName ? initialsOf(comment.authorName) : '◌'}
        </span>
        <span className="tm-dx-comment__who">
          {comment.authorName ?? t('DocumentCommentsPanel.formerMember')}
        </span>
        <time
          className="tm-dx-comment__when"
          dateTime={comment.createdAt}
          title={formatInstant(comment.createdAt)}
        >
          {formatClock(comment.createdAt)}
        </time>
      </div>
      <p className="tm-dx-comment__body" dir="auto">
        {comment.body}
      </p>
    </>
  );
}

/** DOC-02's "11:14": the time of day for today's comments, the date otherwise. */
function formatClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameDay = at.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(
    appDateLocale(appLocale(), appLocale()),
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { day: 'numeric', month: 'short' },
  ).format(at);
}
