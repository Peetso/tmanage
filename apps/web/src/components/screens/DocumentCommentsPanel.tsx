'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { addDocumentComment, listDocumentComments } from '../../lib/api/document-comments';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { initialsOf } from '../docs/DocumentAudience';
import { useT } from '../../lib/i18n/use-t';

export interface DocumentCommentsPanelProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * **Docs "collaboration later" (x132) — document comments.**
 *
 * The collaboration surface `38-MODULE-MAP` §Docs defers ("collaboration later"): a document's
 * comments, read oldest-first, with an add form. It renders as DOC-02's edge column beside the
 * paper sheet of `DocumentViewScreen`, so it is a plain labelled region rather than its own
 * `AppShell` screen.
 *
 * ## Not-found is the read's quiet case
 *
 * The comments list is keyed by the document id. The API resolves that id **tenant-scoped before the
 * relation check**, so an id in another tenant, a document the caller is not a member of, and an id
 * that does not exist all answer the same 404. This panel shows that 404 as a plain "not available"
 * note (the parent screen already renders the document's own not-found state), and every other
 * refusal as an error, so a transient outage is not misread as "no comments".
 *
 * ## People are shown by name
 *
 * The API resolves each author's membership to a display name inside the tenant (`authorName`); an
 * author it could not name (a membership since removed) reads "A former member", never an id.
 *
 * Comments are internal: DOC-02's footnote says so, because publishing shares the body only.
 */
export function DocumentCommentsPanel({
  organizationSlug,
  documentId,
  client,
}: DocumentCommentsPanelProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const comments = useQuery({
    queryKey: ['document-comments', organizationSlug, documentId],
    queryFn: () => listDocumentComments(api, organizationSlug, documentId),
  });

  const [draft, setDraft] = useState('');

  const add = useMutation({
    mutationFn: () => addDocumentComment(api, organizationSlug, documentId, draft.trim()),
    onSuccess: async () => {
      setDraft('');
      await queryClient.invalidateQueries({
        queryKey: ['document-comments', organizationSlug, documentId],
      });
    },
  });

  const notAvailable =
    comments.isError && comments.error instanceof ApiRequestError && comments.error.status === 404;

  const rows = comments.data ?? [];
  const canAdd = draft.trim() !== '';

  return (
    <section className="tm-dx-edge" aria-labelledby="tm-document-comments">
      <h2 id="tm-document-comments" className="tm-dx-edge__caption">
        {t('DocumentCommentsPanel.comments')}
        {!comments.isPending && !comments.isError ? ` · ${rows.length}` : ''} ·{' '}
        {t('DocumentCommentsPanel.internalOnly')}
      </h2>

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

      {!comments.isPending && !comments.isError ? (
        rows.length > 0 ? (
          <ol className="tm-dx-comments" aria-label={t('DocumentCommentsPanel.listAria')}>
            {rows.map((comment) => (
              <li key={comment.id} className="tm-dx-comment">
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
                <p className="tm-dx-comment__body">{comment.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="tm-dx-quiet">{t('DocumentCommentsPanel.empty')}</p>
        )
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

/** DOC-02's "11:14": the time of day for today's comments, the date otherwise. */
function formatClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameDay = at.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { day: 'numeric', month: 'short' },
  ).format(at);
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
