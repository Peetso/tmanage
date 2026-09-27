'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { appendThreadReply, listThreadReplies } from '../../lib/api/thread-replies';
import type { ThreadReplyView as ThreadReply } from '../../lib/api/thread-replies';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface ThreadViewProps {
  organizationSlug: string;
  conversationId: string;
  /** The root message the thread hangs off — CH-05's pinned source. */
  rootMessageId: string;
  /** The root message's body, shown as the panel's anchor. Optional: the id anchors it either way. */
  rootMessageBody?: string;
  client?: ApiClient;
}

/**
 * **x249 — a message's thread panel (planning ref CH-05 "Thread").**
 *
 * The thread pane `38-MODULE-MAP` §Chat names: a message's replies, read oldest-first, with a
 * composer to add one. It anchors to the root message and renders beside `ChatScreen`/the
 * channel view, so it is a plain labelled region rather than its own `AppShell` screen.
 *
 * ## Not-found is the read's quiet case
 *
 * The thread is keyed by the conversation and root message ids. The API resolves both
 * **tenant-scoped before the relation check**, so an id in another tenant, a channel the caller
 * is not a member of, and an id that does not exist all answer the same 404. This panel shows
 * that 404 as a plain "not available" note and every other refusal as an error, so a transient
 * outage is not misread as "no replies".
 *
 * ## People are shown by membership id
 *
 * No endpoint resolves a membership id to a display name here, so an author is shown by the
 * membership id — the honesty `DocumentCommentsPanel` applies to the same gap.
 */
export function ThreadView({
  organizationSlug,
  conversationId,
  rootMessageId,
  rootMessageBody,
  client,
}: ThreadViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const queryKey = ['thread-replies', organizationSlug, conversationId, rootMessageId];

  const thread = useQuery({
    queryKey,
    queryFn: () => listThreadReplies(api, organizationSlug, conversationId, rootMessageId),
  });

  const [draft, setDraft] = useState('');

  const reply = useMutation({
    mutationFn: () =>
      appendThreadReply(api, organizationSlug, conversationId, rootMessageId, draft.trim()),
    onSuccess: async () => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const notAvailable =
    thread.isError && thread.error instanceof ApiRequestError && thread.error.status === 404;

  const replies = thread.data?.replies ?? [];
  const canReply = draft.trim() !== '';

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-thread-replies">
      <h2 id="tm-thread-replies" className="tm-eyebrow">
        Thread
      </h2>

      {rootMessageBody !== undefined ? (
        <p className="tm-prose" aria-label="Thread source message">
          {rootMessageBody}
        </p>
      ) : null}

      {thread.isPending ? (
        <LoadingRegion label="Loading replies.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notAvailable ? (
        <InlineAlert tone="neutral" title="Thread unavailable" live>
          This thread is not available.
        </InlineAlert>
      ) : null}

      {thread.isError && !notAvailable ? (
        <InlineAlert tone="danger" title="Could not load the thread" live>
          {describeError(thread.error)}
        </InlineAlert>
      ) : null}

      {!thread.isPending && !thread.isError ? (
        replies.length > 0 ? (
          <ol className="tm-stack" aria-label="Replies in this thread">
            {replies.map((item) => (
              <ThreadReplyView key={item.id} reply={item} />
            ))}
          </ol>
        ) : (
          <p className="tm-prose">No replies yet.</p>
        )
      ) : null}

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canReply) reply.mutate();
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-thread-reply-body">
            Reply in thread
          </label>
          <textarea
            id="tm-thread-reply-body"
            name="body"
            className="tm-field__control tm-field__control--multiline"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>

        {reply.isError ? (
          <InlineAlert tone="danger" title="Could not post the reply" live>
            {describeError(reply.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={reply.isPending}
            loadingLabel="Posting"
            disabled={!canReply}
          >
            Reply
          </Button>
        </div>
      </form>
    </section>
  );
}

export interface ThreadReplyViewProps {
  reply: ThreadReply;
}

/** One reply — its body, and the membership and time that authored it. */
export function ThreadReplyView({ reply }: ThreadReplyViewProps) {
  return (
    <li className="tm-stack">
      <p className="tm-prose">{reply.body}</p>
      <p className="tm-field__hint">
        {reply.authorMembershipId} · {formatInstant(reply.createdAt)}
      </p>
    </li>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
