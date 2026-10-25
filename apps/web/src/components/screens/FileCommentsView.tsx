'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { addFileComment, listFileComments, removeFileComment } from '../../lib/api/file-comments';
import { ApiRequestError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface FileCommentsViewProps {
  organizationSlug: string;
  fileId: string;
  /** The viewing membership; a comment it authored shows the delete control. Absent → none do. */
  viewerMembershipId?: string;
  client?: ApiClient;
}

/**
 * **x333 — file comments.** (Files module.)
 *
 * The in-app discussion on a file the audit found missing: a comment thread on the file detail,
 * read oldest-first, with an add form and a delete control on the viewer's own comments. It renders
 * beside the file detail, so it is a plain labelled region rather than its own `AppShell` screen —
 * the `DocumentCommentsPanel` (x132) posture.
 *
 * ## Not-found is the read's quiet case
 *
 * The thread is keyed by the file id. The API resolves that id **tenant-scoped before the relation
 * check**, so an id in another tenant, a file the caller may not read, and an id that does not exist
 * all answer the same 404. This view shows that 404 as a plain "not available" note and every other
 * refusal as an error, so a transient outage is not misread as "no comments".
 *
 * ## People are shown by id
 *
 * No endpoint resolves a membership id to a display name here, so an author is shown by the
 * membership id — the honesty the sibling comment and workload surfaces apply to the same gap. The
 * delete control turns on `createdBy === viewerMembershipId`; the server enforces the same rule, so
 * a comment the viewer does not own is refused there even if a control were shown.
 */
export function FileCommentsView({
  organizationSlug,
  fileId,
  viewerMembershipId,
  client,
}: FileCommentsViewProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const queryKey = ['file-comments', organizationSlug, fileId] as const;

  const comments = useQuery({
    queryKey,
    queryFn: () => listFileComments(api, organizationSlug, fileId),
  });

  const [draft, setDraft] = useState('');

  const add = useMutation({
    mutationFn: () => addFileComment(api, organizationSlug, fileId, draft.trim()),
    onSuccess: async () => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (commentId: string) => removeFileComment(api, organizationSlug, fileId, commentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const notAvailable =
    comments.isError && comments.error instanceof ApiRequestError && comments.error.status === 404;

  const rows = comments.data ?? [];
  const canAdd = draft.trim() !== '' && !add.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-file-comments">
      <h2 id="tm-file-comments" className="tm-eyebrow">
        {t('FileCommentsView.comments')}
      </h2>

      {comments.isPending ? (
        <LoadingRegion label={t('FileCommentsView.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notAvailable ? (
        <InlineAlert tone="neutral" title={t('FileCommentsView.unavailableTitle')} live>
          {t('FileCommentsView.unavailableBody')}
        </InlineAlert>
      ) : null}

      {comments.isError && !notAvailable ? (
        <InlineAlert tone="danger" title={t('FileCommentsView.loadError')} live>
          {describeError(comments.error)}
        </InlineAlert>
      ) : null}

      {remove.isError ? (
        <InlineAlert tone="danger" title={t('FileCommentsView.deleteError')} live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}

      {!comments.isPending && !comments.isError ? (
        rows.length > 0 ? (
          <ol className="tm-stack" aria-label={t('FileCommentsView.listAria')}>
            {rows.map((comment) => (
              <li key={comment.id} className="tm-stack">
                <p className="tm-prose">{comment.body}</p>
                <div className="tm-row">
                  <p className="tm-field__hint">
                    {comment.createdBy} · {formatInstant(comment.createdAt)}
                  </p>
                  {viewerMembershipId && comment.createdBy === viewerMembershipId ? (
                    <Button
                      type="button"
                      tone="destructive"
                      size="compact"
                      loading={remove.isPending && remove.variables === comment.id}
                      loadingLabel={t('FileCommentsView.deleting')}
                      onClick={() => remove.mutate(comment.id)}
                    >
                      {t('FileCommentsView.delete')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="tm-prose">{t('FileCommentsView.empty')}</p>
        )
      ) : null}

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canAdd) add.mutate();
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-file-comment-body">
            {t('FileCommentsView.addLabel')}
          </label>
          <textarea
            id="tm-file-comment-body"
            name="body"
            className="tm-field__control tm-field__control--multiline"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>

        {add.isError ? (
          <InlineAlert tone="danger" title={t('FileCommentsView.addError')} live>
            {describeError(add.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('FileCommentsView.adding')}
            disabled={!canAdd}
          >
            {t('FileCommentsView.addComment')}
          </Button>
        </div>
      </form>
    </section>
  );
}
