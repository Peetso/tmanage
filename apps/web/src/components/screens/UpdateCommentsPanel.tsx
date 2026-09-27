'use client';

import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  listProjectUpdateComments,
  postProjectUpdateComment,
  type UpdateComment,
} from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface UpdateCommentsPanelProps {
  organizationSlug: string;
  projectId: string;
  updateId: string;
  api: ApiClient;
}

const MAX_BODY_LENGTH = 5000;

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString();
}

/**
 * **x203 — a comment thread on a client update.** (Client portal, module 13.)
 *
 * The internal compose surface for the update comment lifecycle 0041 deferred: post an internal
 * comment on a published update, see the thread oldest-first. The comments the studio posts here are
 * shown to the client reading that update's timeline; a client *reply* is a later slice (it needs a
 * client-write capability). Edit and delete are deferred too — this panel does post / list only,
 * matching the append-only route behind it, behind `project.manage`.
 *
 * A distinct file from x125's update compose panel: it reads its own query and invalidates it on
 * every write so the list reflects the server rather than an optimistic guess.
 */
export function UpdateCommentsPanel({
  organizationSlug,
  projectId,
  updateId,
  api,
}: UpdateCommentsPanelProps) {
  const queries = useQueryClient();
  const queryKey = ['project-update-comments', organizationSlug, projectId, updateId] as const;
  const bodyId = useId();
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const comments = useQuery({
    queryKey,
    queryFn: () => listProjectUpdateComments(api, organizationSlug, projectId, updateId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (nextBody: string) =>
      postProjectUpdateComment(api, organizationSlug, projectId, updateId, { body: nextBody }),
    onSuccess: () => {
      setBody('');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (trimmed === '') return;
    add.mutate(trimmed);
  }

  const items: readonly UpdateComment[] = comments.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-update-comments">
      <h2 id="tm-update-comments" className="tm-eyebrow">
        Comments
      </h2>

      {comments.isPending ? (
        <LoadingRegion label="Loading this update’s comments.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {comments.isError ? (
        <InlineAlert tone="danger" title="Could not load the comments" live>
          {describe(comments.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      {comments.data ? (
        items.length === 0 ? (
          <p className="tm-prose">No comments yet. Add the first one below.</p>
        ) : (
          <ul className="tm-list" aria-label="Comments">
            {items.map((comment) => (
              <li key={comment.id} className="tm-stack">
                <p className="tm-prose">{comment.body}</p>
                <time className="tm-eyebrow" dateTime={comment.createdAt}>
                  {formatWhen(comment.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={bodyId}>
            Add a comment
          </label>
          <textarea
            id={bodyId}
            className="tm-field__control"
            value={body}
            rows={3}
            maxLength={MAX_BODY_LENGTH}
            onChange={(event) => setBody(event.target.value)}
          />
          <span className="tm-field__hint">
            A comment on this update. It is shown to the client reading the update’s timeline.
          </span>
        </div>
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel="Adding"
            disabled={body.trim() === ''}
          >
            Add comment
          </Button>
        </div>
      </form>
    </section>
  );
}
