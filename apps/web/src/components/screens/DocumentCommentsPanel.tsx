'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { addDocumentComment, listDocumentComments } from '../../lib/api/document-comments';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface DocumentCommentsPanelProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * **Docs "collaboration later" (x132) — document comments.**
 *
 * The collaboration surface `38-MODULE-MAP` §Docs defers ("collaboration later"): a document's
 * comments, read oldest-first, with an add form. It renders beside `DocumentViewScreen`, so it is a
 * plain labelled region rather than its own `AppShell` screen.
 *
 * ## Not-found is the read's quiet case
 *
 * The comments list is keyed by the document id. The API resolves that id **tenant-scoped before the
 * relation check**, so an id in another tenant, a document the caller is not a member of, and an id
 * that does not exist all answer the same 404. This panel shows that 404 as a plain "not available"
 * note (the parent screen already renders the document's own not-found state), and every other
 * refusal as an error, so a transient outage is not misread as "no comments".
 *
 * ## People are shown by id
 *
 * No endpoint resolves a membership id to a display name here, so an author is shown by the
 * membership id — the honesty `DocumentEditorScreen`/`WorkWorkloadScreen` apply to the same gap.
 */
export function DocumentCommentsPanel({
  organizationSlug,
  documentId,
  client,
}: DocumentCommentsPanelProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

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
    <section className="tm-panel tm-stack" aria-labelledby="tm-document-comments">
      <h2 id="tm-document-comments" className="tm-eyebrow">
        Comments
      </h2>

      {comments.isPending ? (
        <LoadingRegion label="Loading comments.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notAvailable ? (
        <InlineAlert tone="neutral" title="Comments unavailable" live>
          Comments are not available for this document.
        </InlineAlert>
      ) : null}

      {comments.isError && !notAvailable ? (
        <InlineAlert tone="danger" title="Could not load comments" live>
          {describeError(comments.error)}
        </InlineAlert>
      ) : null}

      {!comments.isPending && !comments.isError ? (
        rows.length > 0 ? (
          <ol className="tm-stack" aria-label="Comments on this document">
            {rows.map((comment) => (
              <li key={comment.id} className="tm-stack">
                <p className="tm-prose">{comment.body}</p>
                <p className="tm-field__hint">
                  {comment.authorMembershipId} · {formatInstant(comment.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="tm-prose">No comments yet.</p>
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
          <label className="tm-field__label" htmlFor="tm-document-comment-body">
            Add a comment
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
          <InlineAlert tone="danger" title="Could not add the comment" live>
            {describeError(add.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel="Adding"
            disabled={!canAdd}
          >
            Add comment
          </Button>
        </div>
      </form>
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
