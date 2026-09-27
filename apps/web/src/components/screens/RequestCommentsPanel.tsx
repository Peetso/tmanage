'use client';

import { useId, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  addRequestComment,
  listRequestComments,
  removeRequestComment,
  type RequestComment,
} from '../../lib/api/request-comments';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface RequestCommentsPanelProps {
  organizationSlug: string;
  clientRequestId: string;
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

/** Group the flat list into top-level comments each with their (one level of) replies, in order. */
function thread(comments: readonly RequestComment[]): readonly {
  readonly comment: RequestComment;
  readonly replies: readonly RequestComment[];
}[] {
  const tops = comments.filter((comment) => comment.parentId === null);
  return tops.map((comment) => ({
    comment,
    replies: comments.filter((reply) => reply.parentId === comment.id),
  }));
}

/**
 * **x299 — a client request's internal comment thread.** (Requests module 11; the request-detail
 * screen's internal working-notes section.)
 *
 * Internal staff keep a threaded discussion alongside a client request while triaging it: add a
 * comment, reply once to a comment, retract a comment. It is marked internal and never shown to the
 * client — the route behind it is gated on `client_request.triage` and no client read path selects
 * these rows. Mounted additively beside the rest of the request-detail screen, it reads its own
 * query and invalidates it on every write so the thread reflects the server rather than a guess.
 */
export function RequestCommentsPanel({
  organizationSlug,
  clientRequestId,
  api,
}: RequestCommentsPanelProps) {
  const queries = useQueryClient();
  const queryKey = ['request-comments', organizationSlug, clientRequestId] as const;
  const bodyId = useId();
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const comments = useQuery({
    queryKey,
    queryFn: () => listRequestComments(api, organizationSlug, clientRequestId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (input: { body: string; parentId?: string }) =>
      addRequestComment(api, organizationSlug, clientRequestId, input),
    onSuccess: () => {
      setBody('');
      setReplyBody('');
      setReplyTo(null);
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (commentId: string) =>
      removeRequestComment(api, organizationSlug, clientRequestId, commentId),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (trimmed === '') return;
    add.mutate({ body: trimmed });
  }

  function submitReply(event: FormEvent<HTMLFormElement>, parentId: string) {
    event.preventDefault();
    const trimmed = replyBody.trim();
    if (trimmed === '') return;
    add.mutate({ body: trimmed, parentId });
  }

  const threaded = useMemo(() => thread(comments.data ?? []), [comments.data]);

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-request-comments">
      <h2 id="tm-request-comments" className="tm-eyebrow">
        Internal notes
      </h2>
      <p className="tm-field__hint">Visible to your team only — never shown to the client.</p>

      {comments.isPending ? (
        <LoadingRegion label="Loading this request’s internal notes.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {comments.isError ? (
        <InlineAlert tone="danger" title="Could not load the notes" live>
          {describe(comments.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      {comments.data ? (
        threaded.length === 0 ? (
          <p className="tm-prose">No internal notes yet. Add the first one below.</p>
        ) : (
          <ul className="tm-list" aria-label="Internal notes">
            {threaded.map(({ comment, replies }) => (
              <li key={comment.id} className="tm-stack">
                <p className="tm-prose">{comment.body}</p>
                <div className="tm-row">
                  <time className="tm-eyebrow" dateTime={comment.createdAt}>
                    {formatWhen(comment.createdAt)}
                  </time>
                  <Button
                    type="button"
                    tone="text"
                    size="compact"
                    onClick={() => {
                      setReplyTo((current) => (current === comment.id ? null : comment.id));
                      setReplyBody('');
                    }}
                  >
                    Reply
                  </Button>
                  <Button
                    type="button"
                    tone="destructive"
                    size="compact"
                    loading={remove.isPending && remove.variables === comment.id}
                    loadingLabel="Removing"
                    onClick={() => remove.mutate(comment.id)}
                  >
                    Remove
                  </Button>
                </div>

                {replies.length > 0 ? (
                  <ul className="tm-list" aria-label="Replies">
                    {replies.map((reply) => (
                      <li key={reply.id} className="tm-stack">
                        <p className="tm-prose">{reply.body}</p>
                        <div className="tm-row">
                          <time className="tm-eyebrow" dateTime={reply.createdAt}>
                            {formatWhen(reply.createdAt)}
                          </time>
                          <Button
                            type="button"
                            tone="destructive"
                            size="compact"
                            loading={remove.isPending && remove.variables === reply.id}
                            loadingLabel="Removing"
                            onClick={() => remove.mutate(reply.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {replyTo === comment.id ? (
                  <form
                    className="tm-stack"
                    noValidate
                    onSubmit={(event) => submitReply(event, comment.id)}
                  >
                    <textarea
                      className="tm-field__control"
                      aria-label="Reply"
                      value={replyBody}
                      rows={2}
                      maxLength={MAX_BODY_LENGTH}
                      onChange={(event) => setReplyBody(event.target.value)}
                    />
                    <div className="tm-row">
                      <Button
                        type="submit"
                        tone="ink"
                        size="compact"
                        loading={add.isPending}
                        loadingLabel="Replying"
                        disabled={replyBody.trim() === ''}
                      >
                        Reply
                      </Button>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={bodyId}>
            Add an internal note
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
            A working note about this request. Added to the end of the thread.
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
            Add note
          </Button>
        </div>
      </form>
    </section>
  );
}
